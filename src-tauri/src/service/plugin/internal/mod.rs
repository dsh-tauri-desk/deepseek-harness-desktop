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
//!
//! 模块划分：协调/飞行（本文件）与 profile 清单/入口文件操作（[`manifest`]）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

use super::cancel::terminate_owned_install;
use super::install::install_internal;
use super::installed::{installed_name, profile_dir, ProfilePackageJson};
use super::preset::{bundled_dep_spec, bundled_plugin_dir, load_presets, PreinstallPluginInfo};
use super::process::{new_process_owner, ProcessOwner};
use crate::config;

use manifest::{
    dedupe_profile_bundles, dep_matches_spec, internal_plugin_entry_is_ready,
    remove_duplicate_bundle_entries_from_patch, remove_internal_plugins_from_manifest,
    remove_stale_plugin_entry, write_profile_manifest,
};

mod manifest;

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
    owner: ProcessOwner,
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
        ProcessOwner,
        tokio::sync::watch::Sender<Option<Result<(), String>>>,
        tokio::sync::watch::Receiver<Option<Result<(), String>>>,
        tokio::sync::watch::Sender<bool>,
        tokio::sync::watch::Receiver<bool>,
    ) {
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        let owner = new_process_owner();
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

/// 在启动 Harness 前修复旧桌面目录遗留的 profile loader 状态。
///
/// 这一步必须发生在启动 dsh 子进程之前：dsh 会同时合并 bundle patch、profile
/// patch、home patch；如果旧 checkout 曾把内置插件 patch 写入其中，单纯重装
/// `node_modules` 无法消除重复 loader entry。只清理桌面端明确拥有的内置 id，
/// 绝不触碰用户插件。
pub(crate) fn repair_loader_state(app_handle: &AppHandle) -> Result<(), String> {
    let internal: Vec<_> = load_presets(app_handle)
        .into_iter()
        .filter(|preset| preset.internal)
        .collect();
    let bundle_ids: HashSet<&str> = internal.iter().map(|preset| preset.id.as_str()).collect();
    let profile = profile_dir(app_handle);
    let profile_manifest = profile.join("package.json");
    let mut changed_manifest = false;
    if let Ok(raw) = std::fs::read_to_string(&profile_manifest) {
        let mut manifest = serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_PARSE_FAILED: {e}"))?;
        changed_manifest = dedupe_profile_bundles(&mut manifest);
        if changed_manifest {
            write_profile_manifest(&profile_manifest, &manifest)?;
        }
    }

    for patch_path in [
        profile.join("cordis.patch.yml"),
        config::get_dsh_data_path(app_handle).join("cordis.patch.yml"),
    ] {
        let Ok(raw) = std::fs::read_to_string(&patch_path) else {
            continue;
        };
        let mut patch = serde_yaml::from_str::<serde_yaml::Value>(&raw).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_PATCH_PARSE_FAILED: {}: {e}",
                patch_path.display()
            )
        })?;
        if remove_duplicate_bundle_entries_from_patch(&mut patch, &bundle_ids) {
            let rendered = serde_yaml::to_string(&patch)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_RENDER_FAILED: {e}"))?;
            std::fs::write(&patch_path, rendered).map_err(|e| {
                format!(
                    "INTERNAL_PLUGIN_PATCH_WRITE_FAILED: {}: {e}",
                    patch_path.display()
                )
            })?;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: removed stale internal loader entries from {}",
                patch_path.display()
            );
        }
    }

    // dsh 会把运行时组合结果写回 cordis.yml；旧版本留下的组合结果会在下一次
    // 启动时与新 patch 再合并，必须恢复官方约定的空根配置。
    let root = profile.join("cordis.yml");
    const EMPTY_ROOT: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    if std::fs::read_to_string(&root).ok().as_deref() != Some(EMPTY_ROOT) {
        if profile.is_dir() {
            std::fs::write(&root, EMPTY_ROOT).map_err(|e| {
                format!("INTERNAL_PLUGIN_ROOT_WRITE_FAILED: {}: {e}", root.display())
            })?;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: reset stale profile root {}",
                root.display()
            );
        }
    }
    if changed_manifest {
        log::warn!(
            "INTERNAL_PLUGIN_PROFILE_MIGRATED: deduplicated profile bundles in {}",
            profile_manifest.display()
        );
    }
    Ok(())
}

pub(crate) async fn ensure(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    let internal: Vec<_> = presets.into_iter().filter(|p| p.internal).collect();
    if internal.is_empty() {
        return Ok(());
    }

    repair_loader_state(app_handle)?;
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
    owner: ProcessOwner,
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
                terminate_owned_install(owner).await;
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
                    terminate_owned_install(owner).await;
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
    owner: ProcessOwner,
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

    // 旧工作目录留下的 profile 可能含重复 bundle；先做幂等迁移，避免在
    // 检查依赖正常时直接进入 Cordis 并触发 duplicate loader entry。
    let mut migrated = false;
    if let Some(value) = manifest.as_mut() {
        migrated = dedupe_profile_bundles(value);
    }

    let bundle_ids: HashSet<&str> = internal.iter().map(|preset| preset.id.as_str()).collect();
    let patch_path = profile.join("cordis.patch.yml");
    let mut patch = std::fs::read_to_string(&patch_path)
        .ok()
        .and_then(|raw| serde_yaml::from_str::<serde_yaml::Value>(&raw).ok());
    if let Some(value) = patch.as_mut() {
        if remove_duplicate_bundle_entries_from_patch(value, &bundle_ids) {
            let rendered = serde_yaml::to_string(value)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_RENDER_FAILED: {e}"))?;
            std::fs::write(&patch_path, rendered)
                .map_err(|e| format!("INTERNAL_PLUGIN_PATCH_WRITE_FAILED: {e}"))?;
            migrated = true;
            log::warn!(
                "INTERNAL_PLUGIN_PROFILE_MIGRATED: removed duplicate bundle entries from {}",
                patch_path.display()
            );
        }
    }
    if migrated {
        if let Some(value) = manifest.as_ref() {
            write_profile_manifest(&manifest_path, value)?;
        }
    }

    let mut need: Vec<(String, String, PathBuf)> = Vec::new();
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
    //
    // 幂等跳过：仅删除「真的损坏/缺失」的入口。依赖声明缺失（dep_ok=false）但链接本身
    // 健康（link_ok=true）时仍会进入 need，此时绝不要 delete + recreate——Windows 下
    // 重建 junction/reparse point 后立即回读会随机 `-4094 [UNKNOWN] unknown error`
    // （issue #264），一处失败即令整个安装放弃、`link:` 依赖不落盘，下次启动又判定
    // dep_ok=false 再装，形成不可恢复的启动死循环。保留健康链接，交给本轮 `dsh plugin
    // add` 重写依赖声明即可（pnpm 处理 link: 依赖时会自行覆盖旧入口）。
    let mut entries = HashSet::new();
    for (_, _, entry) in &need {
        if !entries.insert(entry.clone()) {
            continue;
        }
        if internal_plugin_entry_is_ready(entry) {
            log::info!(
                "INTERNAL_PLUGIN_ENTRY_HEALTHY: keeping intact link {} (no delete + recreate)",
                entry.display()
            );
            continue;
        }
        remove_stale_plugin_entry(entry).map_err(|e| {
            format!(
                "INTERNAL_PLUGIN_STALE_ENTRY_REMOVE_FAILED: {}: {e}",
                entry.display()
            )
        })?;
    }
    // 复用常规安装编排（环境准备/补齐 pnpm/`dsh plugin add file:<dir>`）；
    // 启动阶段无持有进程，install 内部不会停服务。失败同样交给调用方告警。
    if let Err(e) = install_internal(app_handle, &ids, cancel, owner).await {
        return Err(format!("INTERNAL_PLUGIN_INSTALL_FAILED: {e}"));
    }
    Ok(())
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
            None::<(u64, ProcessOwner, FlightResultSender)>,
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
                tokio::sync::Mutex<Option<(u64, ProcessOwner, FlightResultSender)>>,
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
}
