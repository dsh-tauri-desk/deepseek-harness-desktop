//! 内置插件启动自愈：随安装包分发的内置插件（条目位于
//! `internal-plugins.json`，产物目录 `resources/internal-plugins/<id>` 由构建期
//! `scripts/prebuild.ts` 拉取）在服务启动前核对「是否已安装 + 安装路径是否仍
//! 指向当前捆绑目录」：未安装 / 路径不正确 / 用户卸载后残留缺失 → 一律走常规
//! 安装流程强制重装，保证桌面外壳依赖的桥接层（如 dsh-tauri）随包可用。
//!
//! debug 构建可用仓库根 `.env` 的 `DEV_INTERNAL_PLUGINS_DIR` 把安装目标指到
//! 本地插件源码（热更新迭代，见 [`super::preset::bundled_plugin_dir`]）。
//!
//! 为什么放在启动而非安装流程：安装是用户主动行为，内置插件是应用自身的完整性
//! 要求——用户怎么卸载、何时卸载都不影响下次启动自动恢复，无需任何用户操作。

use std::collections::{HashMap, HashSet};
use std::future::Future;
#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{bundled_dep_spec, bundled_plugin_dir, load_presets, PreinstallPluginInfo};

/// 核对并强制安装缺失/路径不正确/被卸载的内置插件，在服务进程启动前调用。
///
/// 最佳努力：任何失败只记告警（调用方不阻断启动）；捆绑目录缺失（开发环境未跑
/// prebuild）时跳过，交由常规引导流程处理；批量待装列表为空则不触发任何安装。
/// 内置插件阶段事件载荷：除开始/结束外定期发送 heartbeat，令前端只在安装确实
/// 无进展时触发 inactivity deadline，同时仍受绝对上限约束。
#[derive(serde::Serialize, Clone)]
struct InternalPluginsPhase {
    phase: &'static str,
    detail: InternalPluginPhaseDetail,
    completed: usize,
    total: usize,
}

#[derive(serde::Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum InternalPluginPhaseDetail {
    Waiting,
    Checking,
    Installing,
    Heartbeat,
    Done,
    Timeout,
    Cancelled,
}

/// 串行化内置插件核对/安装：auto_start（Rust 侧 start→launch）与前端 boot 流程
/// （新增的 boot 期 ensure 命令）可能并发触发，而安装会启动 `dsh plugin add`
/// 子进程——两个 pnpm 抢同一档案目录会互相打断。若另一路正在执行，这里等它
/// 完成后再核对（幂等：上次已装好则本轮全部 no-op）。
const ENSURE_ABSOLUTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const ENSURE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const ENSURE_OWNER_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
const ENSURE_OWNER_DRAIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Clone)]
struct EnsureFlight {
    id: u64,
    owner: super::process::ProcessOwner,
    state: EnsureFlightState,
    result: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
    cancel: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EnsureFlightState {
    Running,
    Cancelling,
    CleanupFailed(String),
}

enum EnsureSubscription {
    Running(tokio::sync::watch::Receiver<Option<Result<(), String>>>),
    Cancelling(tokio::sync::watch::Receiver<Option<Result<(), String>>>),
    CleanupFailed(String),
}

#[derive(Default)]
struct EnsureCoordinator {
    next_id: u64,
    active: Option<EnsureFlight>,
}

impl EnsureCoordinator {
    fn subscribe(&self) -> Option<EnsureSubscription> {
        self.active.as_ref().map(|flight| match &flight.state {
            EnsureFlightState::Running => EnsureSubscription::Running(flight.result.clone()),
            EnsureFlightState::Cancelling => EnsureSubscription::Cancelling(flight.result.clone()),
            EnsureFlightState::CleanupFailed(reason) => {
                EnsureSubscription::CleanupFailed(reason.clone())
            }
        })
    }

    fn start(
        &mut self,
    ) -> (
        u64,
        super::process::ProcessOwner,
        tokio::sync::watch::Sender<Option<Result<(), String>>>,
        tokio::sync::watch::Receiver<Option<Result<(), String>>>,
        tokio::sync::watch::Sender<bool>,
        tokio::sync::watch::Receiver<bool>,
    ) {
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        let owner = super::process::new_process_owner();
        let (result_tx, result_rx) = tokio::sync::watch::channel(None);
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        self.active = Some(EnsureFlight {
            id,
            owner,
            state: EnsureFlightState::Running,
            result: result_rx.clone(),
            cancel: cancel_tx.clone(),
        });
        (id, owner, result_tx, result_rx, cancel_tx, cancel_rx)
    }

    fn finish(&mut self, id: u64) {
        if self.active.as_ref().is_some_and(|flight| flight.id == id) {
            self.active = None;
        }
    }

    fn begin_cancel(&mut self) -> Option<tokio::sync::watch::Receiver<Option<Result<(), String>>>> {
        let active = self.active.as_mut()?;
        if !matches!(&active.state, EnsureFlightState::CleanupFailed(_)) {
            active.state = EnsureFlightState::Cancelling;
            let _ = active.cancel.send(true);
        }
        Some(active.result.clone())
    }

    fn mark_cleanup_failed(&mut self, id: u64, reason: String) {
        if let Some(active) = self.active.as_mut().filter(|flight| flight.id == id) {
            active.state = EnsureFlightState::CleanupFailed(reason);
        }
    }
}

static ENSURE_LOCK: std::sync::OnceLock<tokio::sync::Mutex<EnsureCoordinator>> =
    std::sync::OnceLock::new();

fn ensure_lock() -> &'static tokio::sync::Mutex<EnsureCoordinator> {
    ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(EnsureCoordinator::default()))
}

pub(crate) async fn ensure(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    let internal: Vec<_> = presets.into_iter().filter(|p| p.internal).collect();
    if internal.is_empty() {
        return Ok(());
    }

    receive_current_or_next_flight(|| subscribe_or_start(app_handle, &internal)).await
}

async fn subscribe_or_start(
    app_handle: &AppHandle,
    internal: &[PreinstallPluginInfo],
) -> EnsureSubscription {
    let mut coordinator = ensure_lock().lock().await;
    match coordinator.subscribe() {
        Some(subscription) => subscription,
        None => {
            let (id, owner, result_tx, result_rx, cancel_tx, cancel_rx) = coordinator.start();
            let app_handle = app_handle.clone();
            let internal = internal.to_vec();
            tauri::async_runtime::spawn(async move {
                let mut outcome =
                    run_ensure_operation(&app_handle, &internal, owner, cancel_tx, cancel_rx).await;
                // 强杀返回不等于持有句柄的 wait 已完成；必须等精确 owner 的 PID
                // 守卫随 wait 退出，才能发布结果并允许 Retry 创建下一次 flight。
                if !wait_for_owner_release(owner, ENSURE_OWNER_DRAIN_TIMEOUT).await {
                    let reason = format!(
                        "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT: plugin process owner {owner:?} remained active for {} seconds",
                        ENSURE_OWNER_DRAIN_TIMEOUT.as_secs()
                    );
                    log::error!("{reason}");
                    outcome = Err(reason.clone());
                    let _ = result_tx.send(Some(outcome));
                    ensure_lock().lock().await.mark_cleanup_failed(id, reason);
                    // 保留 cleanup-failed flight 与唯一 owner；进程锁仍由 wait 线程持有。
                    // 若系统最终完成 reap，再释放 flight 允许后续 Retry。
                    while super::process::active_plugin_pid(owner).is_some() {
                        tokio::time::sleep(ENSURE_OWNER_DRAIN_INTERVAL).await;
                    }
                    ensure_lock().lock().await.finish(id);
                    return;
                }
                ensure_lock().lock().await.finish(id);
                let _ = result_tx.send(Some(outcome));
            });
            EnsureSubscription::Running(result_rx)
        }
    }
}

async fn receive_current_or_next_flight<F, Fut>(mut acquire: F) -> Result<(), String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = EnsureSubscription>,
{
    loop {
        let subscription = acquire().await;
        match subscription {
            EnsureSubscription::Running(mut result) => {
                return receive_flight_result(&mut result).await?;
            }
            EnsureSubscription::Cancelling(mut result) => {
                // Retry 不继承已取消 flight 的结果；等它完成清理并从 coordinator
                // 移除后回到循环，创建且只创建一个全新的 flight。
                let _ = receive_flight_result(&mut result).await?;
            }
            EnsureSubscription::CleanupFailed(reason) => return Err(reason),
        }
    }
}

async fn wait_for_owner_release(
    owner: super::process::ProcessOwner,
    timeout: std::time::Duration,
) -> bool {
    wait_for_release_with(
        || super::process::active_plugin_pid(owner).is_some(),
        timeout,
        ENSURE_OWNER_DRAIN_INTERVAL,
    )
    .await
}

async fn wait_for_release_with<F>(
    mut is_active: F,
    timeout: std::time::Duration,
    interval: std::time::Duration,
) -> bool
where
    F: FnMut() -> bool,
{
    let started = tokio::time::Instant::now();
    loop {
        if !is_active() {
            return true;
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return false;
        }
        tokio::time::sleep(interval.min(timeout - elapsed)).await;
    }
}

async fn receive_flight_result(
    result: &mut tokio::sync::watch::Receiver<Option<Result<(), String>>>,
) -> Result<Result<(), String>, String> {
    loop {
        if let Some(outcome) = result.borrow().clone() {
            return Ok(outcome);
        }
        result.changed().await.map_err(|_| {
            "INTERNAL_PLUGIN_ENSURE_DROPPED: install task ended without result".to_string()
        })?;
    }
}

/// 取消共享的内置插件安装并等待拥有者完成清理，确保 Retry 不会叠加新进程。
pub(crate) async fn cancel() -> Result<(), String> {
    let mut result = {
        let mut coordinator = ensure_lock().lock().await;
        let Some(active) = &coordinator.active else {
            return Ok(());
        };
        log::info!(
            "cancelling internal plugin ensure flight owned by {:?}",
            active.owner
        );
        coordinator
            .begin_cancel()
            .expect("active flight must remain present while coordinator lock is held")
    };
    match receive_flight_result(&mut result).await? {
        Err(reason) if reason.starts_with("INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT:") => Err(reason),
        _ => Ok(()),
    }
}

async fn run_ensure_operation(
    app_handle: &AppHandle,
    internal: &[PreinstallPluginInfo],
    owner: super::process::ProcessOwner,
    cancel_tx: tokio::sync::watch::Sender<bool>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let total = internal.len();
    emit_phase(
        app_handle,
        "loading",
        InternalPluginPhaseDetail::Waiting,
        0,
        total,
    );
    emit_phase(
        app_handle,
        "progress",
        InternalPluginPhaseDetail::Checking,
        0,
        total,
    );
    let refs: Vec<_> = internal.iter().collect();
    let operation = ensure_inner(app_handle, &refs, cancel.clone(), owner);
    tokio::pin!(operation);
    let deadline = tokio::time::sleep(ENSURE_ABSOLUTE_TIMEOUT);
    tokio::pin!(deadline);
    let period = std::time::Duration::from_secs(5);
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            outcome = &mut operation => {
                emit_phase(app_handle, "done", InternalPluginPhaseDetail::Done, total, total);
                return outcome;
            }
            _ = &mut deadline => {
                let reason = "INTERNAL_PLUGIN_INSTALL_TIMEOUT: plugin install exceeded 600 seconds";
                log::error!("{reason}");
                let _ = cancel_tx.send(true);
                super::cancel::terminate_owned_install(owner).await;
                if tokio::time::timeout(ENSURE_CLEANUP_TIMEOUT, &mut operation).await.is_err() {
                    log::error!("INTERNAL_PLUGIN_CLEANUP_TIMEOUT: plugin process did not exit after forced termination");
                }
                emit_phase(app_handle, "done", InternalPluginPhaseDetail::Timeout, 0, total);
                return Err(reason.to_string());
            }
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() {
                    let reason = "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled";
                    log::warn!("{reason}");
                    super::cancel::terminate_owned_install(owner).await;
                    if tokio::time::timeout(ENSURE_CLEANUP_TIMEOUT, &mut operation).await.is_err() {
                        log::error!("INTERNAL_PLUGIN_CLEANUP_TIMEOUT: plugin process did not exit after forced termination");
                    }
                    emit_phase(app_handle, "done", InternalPluginPhaseDetail::Cancelled, 0, total);
                    return Err(reason.to_string());
                }
            }
            _ = heartbeat.tick() => {
                emit_phase(app_handle, "progress", InternalPluginPhaseDetail::Heartbeat, 0, total);
            }
        }
    }
}

fn emit_phase(
    app_handle: &AppHandle,
    phase: &'static str,
    detail: InternalPluginPhaseDetail,
    completed: usize,
    total: usize,
) {
    let _ = app_handle.emit(
        "internal-plugins-phase",
        InternalPluginsPhase {
            phase,
            detail,
            completed,
            total,
        },
    );
}

/// 实际的核对与安装：遍历 internal 预设，未安装 / 路径不对 / 被卸载 → 批量重装。
async fn ensure_inner(
    app_handle: &AppHandle,
    internal: &[&PreinstallPluginInfo],
    cancel: tokio::sync::watch::Receiver<bool>,
    owner: super::process::ProcessOwner,
) -> Result<(), String> {
    log::info!(
        "checking {} internal preset plugins for install state",
        internal.len()
    );

    // 一次读取当前档案；缺失时按「全部未安装」处理，由安装流程自行初始化。已有但
    // 损坏的清单不能静默覆盖，否则可能丢失用户其它插件，故直接给出可诊断错误。
    let profile = profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    let mut manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => Some(
            serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: {e}"))?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("INTERNAL_PLUGIN_MANIFEST_READ_FAILED: {e}")),
    };
    let dependencies: HashMap<String, String> = match manifest.as_ref() {
        Some(value) => {
            serde_json::from_value::<ProfilePackageJson>(value.clone())
                .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_SCHEMA_FAILED: {e}"))?
                .dependencies
        }
        None => HashMap::new(),
    };

    let mut need: Vec<(String, String, std::path::PathBuf)> = Vec::new();
    for preset in internal {
        let Some(bundled) = bundled_plugin_dir(app_handle, &preset.id) else {
            // 未找到内置插件目录：release 说明构建期 prebuild 未拉取（发布缺陷，
            // 由 prebuild 响亮失败）；debug 可用 .env 的 DEV_INTERNAL_PLUGINS_DIR
            // 指向本地源码目录，未配置/缺 id 时跳过（「找不到则不装」）。
            log::warn!(
                "INTERNAL_PLUGIN_BUNDLE_MISSING: {}（release 需构建期 prebuild；debug 可配 .env DEV_INTERNAL_PLUGINS_DIR）",
                preset.id
            );
            continue;
        };
        let name = installed_name(preset).to_string();
        let expected = bundled_dep_spec(&bundled);
        // ① 依赖声明：未声明，或声明的值不再指向当前捆绑目录（路径变更/被改
        // 写）→ 重装；② 依赖真实性：node_modules 链接/拷贝须真实存在（用户
        // 手动清过 node_modules 时声明可能残留但产物已不在）→ 重装。
        let dep_ok = dependencies
            .get(&name)
            .is_some_and(|actual| dep_matches_spec(actual, &expected));
        let entry = profile.join("node_modules").join(&name);
        let link_ok = internal_plugin_entry_is_ready(&entry);
        if !dep_ok || !link_ok {
            log::info!(
                "INTERNAL_PLUGIN_NEEDS_REINSTALL: {name}（dep_ok={dep_ok}, link_ok={link_ok}, expected={expected}）"
            );
            // 应用升级会移动 `.app` 内的捆绑目录，旧 profile 可能留下指向上个
            // 版本资源的悬空链接。pnpm 在处理这些入口时会在真正改写依赖前以
            // 254 退出；先只清理 node_modules 入口（绝不跟随链接删除目标），再
            // 走常规 add，令 pnpm 从当前捆绑目录重建链接。
            need.push((preset.id.clone(), name, entry));
        }
    }
    if need.is_empty() {
        return Ok(());
    }

    let ids: Vec<String> = need.iter().map(|(id, _, _)| id.clone()).collect();
    log::info!("Reinstalling internal preset plugins: {ids:?}");
    emit_phase(
        app_handle,
        "progress",
        InternalPluginPhaseDetail::Installing,
        0,
        ids.len(),
    );

    // pnpm add 会先解析清单里的所有既有依赖。0.9.0 将随包目录从
    // `preset-plugins` 迁至 `internal-plugins` 后，旧 file:/link: 路径已不存在，pnpm
    // 会在真正改写依赖前以 ENOENT/254 退出。仅移除本轮即将重装的 internal 包声明
    // 与 bundle 引用，保留所有其它插件；add 成功后 dsh 会把它们按当前路径写回。
    if let Some(value) = manifest.as_mut() {
        let names: HashSet<&str> = need.iter().map(|(_, name, _)| name.as_str()).collect();
        if remove_internal_plugins_from_manifest(value, &names) {
            write_profile_manifest(&manifest_path, value)?;
        }
    }

    // 必须等全部检查完成后再删除旧入口：多个 internal id 可能映射到同一 npm 包，
    // 边遍历边删除会让后续原本健康的别名被误判缺失。统一去重后只删一次。
    let mut entries = HashSet::new();
    for (_, _, entry) in &need {
        if entries.insert(entry.clone()) {
            remove_stale_plugin_entry(entry).map_err(|e| {
                format!(
                    "INTERNAL_PLUGIN_STALE_ENTRY_REMOVE_FAILED: {}: {e}",
                    entry.display()
                )
            })?;
        }
    }
    // 复用常规安装编排（环境准备/补齐 pnpm/`dsh plugin add file:<dir>`）；
    // 启动阶段无持有进程，install 内部不会停服务。失败同样交给调用方告警。
    if let Err(e) = super::install::install_internal(app_handle, &ids, cancel, owner).await {
        return Err(format!("INTERNAL_PLUGIN_INSTALL_FAILED: {e}"));
    }
    Ok(())
}

/// 读取并解析入口清单，避免仅凭文件存在就把截断或不可读的内置插件视为健康。
fn internal_plugin_entry_is_ready(entry: &Path) -> bool {
    let Ok(raw) = std::fs::read(entry.join("package.json")) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok_and(|manifest| manifest.is_object())
}

/// 从 profile 清单精准移除待重装 internal 包的依赖与 bundle 引用。
fn remove_internal_plugins_from_manifest(
    manifest: &mut serde_json::Value,
    names: &HashSet<&str>,
) -> bool {
    let mut modified = false;
    if let Some(dependencies) = manifest
        .get_mut("dependencies")
        .and_then(serde_json::Value::as_object_mut)
    {
        for name in names {
            modified |= dependencies.remove(*name).is_some();
        }
    }
    if let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|dsh| dsh.get_mut("profile"))
        .and_then(|profile| profile.get_mut("bundles"))
        .and_then(serde_json::Value::as_array_mut)
    {
        let before = bundles.len();
        bundles.retain(|bundle| bundle.as_str().is_none_or(|name| !names.contains(name)));
        modified |= bundles.len() != before;
    }
    modified
}

/// 经同目录临时文件原子替换 profile 清单，失败时保留原文件。
fn write_profile_manifest(path: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    use std::io::Write;

    let rendered = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_RENDER_FAILED: {e}"))?;
    let temp = path.with_extension(format!("json.internal.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(format!("{rendered}\n").as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace_manifest_file(&temp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("INTERNAL_PLUGIN_MANIFEST_WRITE_FAILED: {e}"));
    }
    log::info!(
        "Removed stale internal plugin declarations from profile manifest: {}",
        path.display()
    );
    Ok(())
}

#[cfg(not(windows))]
fn replace_manifest_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, path)
}

#[cfg(windows)]
fn replace_manifest_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            path_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// 删除失效的插件入口，但绝不跟随符号链接 / junction 删除捆绑资源。
///
/// 正常目录只可能是 pnpm 留下的损坏产物，可以递归清理；Unix 符号链接与 Windows
/// junction 则只删除入口本身。入口不存在（包括已被并发清掉）视为幂等成功。
fn remove_stale_plugin_entry(entry: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(entry) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let file_type = metadata.file_type();
    #[cfg(windows)]
    if file_type.is_symlink_dir() {
        return std::fs::remove_dir(entry);
    }
    if file_type.is_symlink() {
        return std::fs::remove_file(entry);
    }
    if file_type.is_dir() {
        return std::fs::remove_dir_all(entry);
    }
    std::fs::remove_file(entry)
}

/// 判断 pnpm 写入 profile 的依赖值与期望的 `link:` 捆绑路径是否一致。
///
/// 容忍：`link:`/`file:` 前缀缺失或两者混写（历史遗留 `file:` 安装值）；Windows
/// 下路径大小写不敏感；尾部斜杠差异（pnpm 各版本落盘形式略有出入）。
fn dep_matches_spec(actual: &str, expected: &str) -> bool {
    let norm = |spec: &str| {
        let stripped = spec
            .strip_prefix("link:")
            .or_else(|| spec.strip_prefix("file:"))
            .unwrap_or(spec);
        // 统一用 dunce 归一化 Windows 扩展长度路径前缀（`\\?\`）：
        // 期望值已经由 bundled_dep_spec 归一化掉前缀；若历史命中的实值仍带
        // `//?/` / `\\?\` 前缀，先归一再比对，保证幂等（避免旧值一次次触发
        // 不必要的重装）。先把手写正斜杠的 verbatim 形式（`//?/`）换算成反斜杠
        // （dunce 依赖 `\\?\` 识别 verbatim），再交给 dunce::simplified，最后
        // 统一回正斜杠，与 bundled_dep_spec 的产出可比。
        let backslash = stripped.replace('/', "\\");
        dunce::simplified(Path::new(&backslash))
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    let actual = norm(actual);
    let expected = norm(expected);
    if cfg!(windows) {
        actual.eq_ignore_ascii_case(&expected)
    } else {
        actual == expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn coordinator_coalesces_waiters_and_releases_for_retry() {
        let mut coordinator = EnsureCoordinator::default();
        let (first_id, first_owner, result_tx, first, _, _) = coordinator.start();
        let EnsureSubscription::Running(duplicate) = coordinator.subscribe().unwrap() else {
            panic!("running flight must coalesce running waiters");
        };
        assert_eq!(coordinator.active.as_ref().unwrap().owner, first_owner);
        coordinator.finish(first_id);
        assert!(coordinator.subscribe().is_none());
        result_tx.send(Some(Ok(()))).unwrap();
        assert_eq!(first.borrow().as_ref(), Some(&Ok(())));
        assert_eq!(duplicate.borrow().as_ref(), Some(&Ok(())));

        let (retry_id, _, _, _, _, _) = coordinator.start();
        assert_ne!(retry_id, first_id);
    }

    #[tokio::test]
    async fn cancel_then_immediate_retry_starts_one_fresh_flight() {
        type FlightResultSender = tokio::sync::watch::Sender<Option<Result<(), String>>>;

        let coordinator =
            std::sync::Arc::new(tokio::sync::Mutex::new(EnsureCoordinator::default()));
        let fresh_flight = std::sync::Arc::new(tokio::sync::Mutex::new(
            None::<(u64, super::super::process::ProcessOwner, FlightResultSender)>,
        ));
        let fresh_started = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelling_subscribers = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cancelling_subscribed = std::sync::Arc::new(tokio::sync::Notify::new());

        let (cancelled_id, cancelled_owner, cancelled_tx) = {
            let mut coordinator = coordinator.lock().await;
            let (id, owner, result_tx, _, _, mut cancel_signal) = coordinator.start();
            coordinator.begin_cancel().unwrap();
            assert!(*cancel_signal.borrow_and_update());
            (id, owner, result_tx)
        };

        async fn retry(
            coordinator: std::sync::Arc<tokio::sync::Mutex<EnsureCoordinator>>,
            fresh_flight: std::sync::Arc<
                tokio::sync::Mutex<
                    Option<(u64, super::super::process::ProcessOwner, FlightResultSender)>,
                >,
            >,
            fresh_started: std::sync::Arc<std::sync::atomic::AtomicUsize>,
            cancelling_subscribers: std::sync::Arc<std::sync::atomic::AtomicUsize>,
            cancelling_subscribed: std::sync::Arc<tokio::sync::Notify>,
        ) -> Result<(), String> {
            receive_current_or_next_flight(|| {
                let coordinator = coordinator.clone();
                let fresh_flight = fresh_flight.clone();
                let fresh_started = fresh_started.clone();
                let cancelling_subscribers = cancelling_subscribers.clone();
                let cancelling_subscribed = cancelling_subscribed.clone();
                async move {
                    let mut coordinator = coordinator.lock().await;
                    if let Some(subscription) = coordinator.subscribe() {
                        if matches!(&subscription, EnsureSubscription::Cancelling(_)) {
                            cancelling_subscribers
                                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            cancelling_subscribed.notify_one();
                        }

                        return subscription;
                    }
                    let (id, owner, result_tx, result_rx, _, _) = coordinator.start();
                    fresh_started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    *fresh_flight.lock().await = Some((id, owner, result_tx));
                    EnsureSubscription::Running(result_rx)
                }
            })
            .await
        }

        let first_retry = tokio::spawn(retry(
            coordinator.clone(),
            fresh_flight.clone(),
            fresh_started.clone(),
            cancelling_subscribers.clone(),
            cancelling_subscribed.clone(),
        ));
        let second_retry = tokio::spawn(retry(
            coordinator.clone(),
            fresh_flight.clone(),
            fresh_started.clone(),
            cancelling_subscribers.clone(),
            cancelling_subscribed.clone(),
        ));

        while cancelling_subscribers.load(std::sync::atomic::Ordering::SeqCst) < 2 {
            cancelling_subscribed.notified().await;
        }
        {
            let mut coordinator = coordinator.lock().await;
            coordinator.finish(cancelled_id);
        }
        cancelled_tx
            .send(Some(Err(
                "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled".to_string(),
            )))
            .unwrap();

        let (retry_id, retry_owner, retry_tx) = loop {
            if let Some(flight) = fresh_flight.lock().await.take() {
                break flight;
            }
            tokio::task::yield_now().await;
        };
        assert_ne!(retry_owner, cancelled_owner);
        assert_eq!(fresh_started.load(std::sync::atomic::Ordering::SeqCst), 1);

        coordinator.lock().await.finish(retry_id);
        retry_tx.send(Some(Ok(()))).unwrap();
        assert!(first_retry.await.unwrap().is_ok());
        assert!(second_retry.await.unwrap().is_ok());
        assert_eq!(fresh_started.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(coordinator.lock().await.subscribe().is_none());
    }

    #[tokio::test]
    async fn stuck_owner_is_bounded_and_blocks_new_flights_without_hanging_waiters() {
        let released = wait_for_release_with(
            || true,
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(1),
        )
        .await;
        assert!(!released);

        let mut coordinator = EnsureCoordinator::default();
        let (id, _, result_tx, mut result, _, _) = coordinator.start();
        let reason = "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT: test owner remained active".to_string();
        result_tx.send(Some(Err(reason.clone()))).unwrap();
        coordinator.mark_cleanup_failed(id, reason.clone());

        assert!(matches!(
            coordinator.subscribe(),
            Some(EnsureSubscription::CleanupFailed(error)) if error == reason
        ));
        let outcome = receive_flight_result(&mut result).await.unwrap();
        assert_eq!(outcome, Err(reason));
        assert_eq!(coordinator.next_id, 1);
    }

    #[test]
    fn internal_plugin_entry_requires_readable_manifest_object() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-entry-readiness-{}",
            std::process::id()
        ));
        let manifest = root.join("package.json");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, br#"{"name":"dsh-tauri"}"#).unwrap();
        assert!(internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, br#"{"name":"dsh-tauri""#).unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, b"[]").unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_internal_manifest_entries_are_removed_without_touching_other_plugins() {
        let mut manifest = serde_json::json!({
            "private": true,
            "dependencies": {
                "dsh-tauri": "file:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/preset-plugins/dsh-tauri",
                "dsh-tauri-ui": "link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/preset-plugins/dsh-tauri-ui",
                "dshmarket": "github:dsh-market/dshmarket"
            },
            "dsh": {
                "profile": {
                    "bundles": ["dsh-tauri", "dsh-tauri-ui", "dshmarket"]
                }
            }
        });
        let names = HashSet::from(["dsh-tauri", "dsh-tauri-ui"]);

        assert!(remove_internal_plugins_from_manifest(&mut manifest, &names));
        assert_eq!(
            manifest["dependencies"],
            serde_json::json!({ "dshmarket": "github:dsh-market/dshmarket" })
        );
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["dshmarket"])
        );
        assert!(!remove_internal_plugins_from_manifest(
            &mut manifest,
            &names
        ));
    }

    #[test]
    fn manifest_replacement_preserves_original_when_temp_write_fails() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-manifest-write-failure-{}",
            std::process::id()
        ));
        let path = root.join("package.json");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("sentinel"), "original").unwrap();

        let error = write_profile_manifest(&path, &serde_json::json!({ "private": true }))
            .expect_err("directory destination must reject replacement");

        assert!(error.starts_with("INTERNAL_PLUGIN_MANIFEST_WRITE_FAILED:"));
        assert_eq!(
            std::fs::read_to_string(path.join("sentinel")).unwrap(),
            "original"
        );
        assert!(!root
            .join(format!("package.json.internal.{}.tmp", std::process::id()))
            .exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_plain_directory_is_removed() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-stale-directory-{}",
            std::process::id()
        ));
        let entry = root.join("node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join("partial"), "broken").unwrap();

        remove_stale_plugin_entry(&entry).unwrap();

        assert!(!entry.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn stale_symlink_is_removed_without_touching_target() {
        let root =
            std::env::temp_dir().join(format!("dsh-internal-stale-symlink-{}", std::process::id()));
        let target = root.join("old-app/dsh-tauri-ui");
        let entry = root.join("profile/node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &entry).unwrap();

        remove_stale_plugin_entry(&entry).unwrap();

        assert!(target.join("package.json").is_file());
        assert!(std::fs::symlink_metadata(&entry).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_is_removed_idempotently() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-dangling-symlink-{}",
            std::process::id()
        ));
        let entry = root.join("profile/node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.join("missing-app/dsh-tauri-ui"), &entry).unwrap();

        remove_stale_plugin_entry(&entry).unwrap();
        remove_stale_plugin_entry(&entry).unwrap();

        assert!(std::fs::symlink_metadata(&entry).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dep_spec_matches_itself() {
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        // 与自身一致
        assert!(dep_matches_spec(expected, expected));
        // 无 link:/file: 前缀（pnpm 某些场景直接落路径）
        assert!(dep_matches_spec(
            "C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
        // 尾部斜杠差异
        assert!(dep_matches_spec(
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri/",
            expected
        ));
        // 反斜杠（Windows 原生形式）
        assert!(dep_matches_spec(
            "link:C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri",
            expected
        ));
        // 历史遗留 file: 形式（协议切换前已安装的值）
        assert!(dep_matches_spec(
            "file:C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }

    #[test]
    fn dep_spec_rejects_wrong_path_or_source() {
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        // 仍指向 npm 版本（用户手动从 npm 安装，非捆绑 link: 源）
        assert!(!dep_matches_spec("dsh-tauri@0.2.0", expected));
        // 指向其它位置（旧版本安装目录等）
        assert!(!dep_matches_spec("link:D:/elsewhere/dsh-tauri", expected));
        // 同名不同宿主盘符
        assert!(!dep_matches_spec(
            "link:D:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }

    #[cfg(windows)]
    #[test]
    fn dep_spec_case_insensitive_on_windows() {
        // Windows 文件系统大小写不敏感，路径比较须忽略大小写
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        assert!(dep_matches_spec(
            "link:c:/apps/DSH/resources/internal-plugins/Dsh-Tauri",
            expected
        ));
        // 实值仍带 Windows 扩展长度前缀（`\\?\`，dunce::simplified 归一化）时，
        // 与归一化掉前缀的期望值仍视为同一路径（幂等，避免不必要的重装）
        assert!(dep_matches_spec(
            "link://?/C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }
}
