//! Harness 服务启动编排：`start` / `restart` / `launch`，含端口自愈
//! （避让递增 + 回落、等待释放）、`--no-open` 版本判定、补丁挂点与
//! Windows 隐藏控制台启动。

use crate::config;
use std::collections::HashMap;
#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;

#[cfg(not(windows))]
use super::process::set_owned_process;
#[cfg(windows)]
use super::process::set_owned_process_with_handle;
#[cfg(unix)]
use super::process::warn_if_inotify_watch_limit_low;
use super::process::{
    has_owned_process, on_owned_process_exit, stop, terminate_stale_harness_processes, LaunchGuard,
    LAUNCH_GUARD,
};
use super::status;
use super::sweep::persist_harness_pid;
#[cfg(windows)]
use super::sweep::{dsh_bin_open_error, relaunch_marker_path, relaunch_via_shell_escape};
use super::utils::{is_port_in_use, rotate_service_log, spawn_output_readers};
use super::win_inspector;

/// 端口释放等待上限：刚结束/清扫过上个会话的残留 dsh 进程后，TCP 端口释放
/// 存在短暂滞后（taskkill 返回 ≠ 端口已可复用）。等待窗口内端口回落为空闲则
/// 复用配置端口；到期仍未释放才按“真占用”逐级递增。
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 轮询等待配置端口释放为空闲（端口本来就空闲则立即返回）。
///
/// async（tokio）实现，避免长时间阻塞启动线程。与 `stop()` 里“给系统一点时间
/// 释放端口”的目的一致，但以“端口确实空闲”为准而不是固定睡 800ms——因此
/// 端口很快释放时几乎不额外耗时，只有真占用才等到超时。
async fn wait_for_port_release(port: u16) {
    let deadline = tokio::time::Instant::now() + PORT_RELEASE_WAIT;
    while tokio::time::Instant::now() < deadline {
        if !is_port_in_use(port) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
}

/// 从起始端口向上查找第一个空闲端口，绝不结束未知的端口占用进程。
fn find_available_port(start: u16) -> Result<u16, String> {
    find_available_port_by(start, is_port_in_use)
}

/// 按调用方提供的占用判定查找第一个空闲端口。
///
/// 将扫描决策与真实套接字状态分离，使单测能确定性验证递增与溢出，不在函数
/// 返回后再次探测系统端口；后者存在不可消除的 TOCTOU，任何端口段都可能被
/// 其他进程在两次探测之间占用。
fn find_available_port_by(
    start: u16,
    mut is_in_use: impl FnMut(u16) -> bool,
) -> Result<u16, String> {
    let mut port = start;
    loop {
        if !is_in_use(port) {
            return Ok(port);
        }
        log::warn!("Port {port} is occupied, trying the next port");
        port = port.checked_add(1).ok_or_else(|| {
            "PORT_EXHAUSTED: no available TCP port after the configured port".to_string()
        })?;
    }
}

/// 启动时端口自愈决策（纯函数，便于单测）。
///
/// 自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口只在回落目标
/// （用户手动端口或默认端口）空闲时才回落；回落目标被占则维持当前端口，
/// 留给 `find_available_port` 逐级递增。用户手动设置的端口经 `manual_port`
/// 记录，回落目标即用户值；从未手动设置时回落目标是默认端口（3080/3081）。
/// 返回值与 `configured` 相同表示无需自愈。
fn resolve_heal_port(configured: u16, heal_target: u16, heal_target_free: bool) -> u16 {
    if configured != heal_target && heal_target_free {
        heal_target
    } else {
        configured
    }
}

/// dsh 版本是否支持 `--no-open` 标志。
///
/// 0.1.0-rc.8 起 `dsh web` 默认在系统浏览器打开 UI（桌面端内嵌 WebView，
/// 不希望每次启动都弹浏览器），并新增 `--no-open` 关闭该行为。更早的 rc
/// 版本没有这个标志，commander 会把未知选项当作错误、导致 web profile
/// 启动失败，因此追加标志前必须按已装版本判定：0.1.0-rc.8 及以上传标志；
/// 更早不传（保持旧行为）。
///
/// 比较用 `semver` 库按完整语义化版本进行：只比 rc 序号会把基础版本更大的
/// 新版本误判为旧版——`0.1.1-rc.1` 的 rc 号（1）虽小于 8，但晚于
/// 0.1.0-rc.8，同样支持 `--no-open`（该误判是浏览器复弹的回归根因）。
/// 版本号非法（无法解析）时保守处理：不追加标志。
fn version_supports_no_open(version: &str) -> bool {
    // 首个支持 `--no-open` 的 dsh 版本（0.1.0-rc.8）
    const NO_OPEN_MIN_VERSION: &str = "0.1.0-rc.8";
    let Ok(min) = semver::Version::parse(NO_OPEN_MIN_VERSION) else {
        return false;
    };
    semver::Version::parse(version)
        .map(|v| v >= min)
        .unwrap_or(false)
}

/// 按当前活动核心的 dsh 版本决定是否追加 `--no-open`（见 [`version_supports_no_open`]）。
///
/// 版本以活动核心为准：本地核心（用户 CLI 安装）与预打包核心各自读自己的
/// 包清单；读不到时保守处理：不追加标志。
fn dsh_binary_version(binary: &std::path::Path) -> Option<String> {
    let package_dir = binary.parent()?.parent()?;
    let manifest = package_dir.join("package.json");
    let content = fs::read_to_string(manifest).ok()?;
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()?
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

/// 按实际将要执行的 dsh `bin.js` 判定 `--no-open` 能力。
///
/// 核心切换槽位的外层 package.json 可能没有 `dependencies` 清单（源码构建
/// alpha 尤其如此），因此不能只读取活动核心登记版本；必须读取入口所属的
/// `@deepseek-ai/dsh/package.json`，避免 alpha 因版本读空而漏传参数。
fn web_supports_no_open_flag(
    app_handle: &tauri::AppHandle,
    dsh_binary_path: &std::path::Path,
) -> bool {
    dsh_binary_version(dsh_binary_path)
        .or_else(|| crate::service::core::active_version(app_handle))
        .map(|version| version_supports_no_open(&version))
        .unwrap_or(false)
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的入口：本地核心存在时优先本地（需求 3），否则预打包
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
        // Windows RedirectionGuard(448)：安装器继承的强制执行上下文永不自行恢复，
        // 先尝试通过 explorer 逃逸重拉（见 relaunch_via_shell_escape 注释），
        // 成功则本进程退出；未命中（重拉未逃逸/非 448）才走常规缺失处理。
        #[cfg(windows)]
        if dsh_bin_open_error(&app_handle) == Some(448) {
            relaunch_via_shell_escape(&app_handle);
        }
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.installed = false;
        config::set_store_dat_setting(&app_handle, setting);
        // 状态变更需要 info 级落盘：这是「store 显示未安装」的源头之一
        // （核心文件短暂缺失被复位），自更新后自动重开走进安装分支多由此触发。
        log::info!("Runtime files missing (node/dsh), resetting installed flag");
        return Ok(());
    }

    if has_owned_process() {
        log::info!("Owned Harness process is already running");
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    // 清理 RedirectionGuard(448) 逃逸重拉标记：本进程正常走到启动说明处于干净上下文，
    // 移除标记保证下次自更新后仍能触发逃逸重拉。
    #[cfg(windows)]
    let _ = std::fs::remove_file(relaunch_marker_path(&app_handle));

    log::info!("Starting Harness service");
    status::set_status(status::Status::Starting);
    status::emit_status(&app_handle);
    launch(app_handle).await?;
    // 之后由 scheduler/task/tick_check_dsh_process/mod.rs 检测状态

    Ok(())
}

/// 重启 Harness 服务
pub async fn restart(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Restarting Harness service");

    // 1. 停止现有服务
    stop(app_handle.clone()).await?;

    // 2. 重新启动
    start(app_handle).await?;

    Ok(())
}

/// 把 active profile 的 `cordis.yml` 重置为官方空根。
///
/// dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
/// `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
/// tree）。上一轮被杀/崩溃的 dsh 若留下组合行，新 boot 会读到已含 bundle 行的
/// 文件，再叠加同一批 patch → `duplicate loader entry`。spawn 前与「早期退出
/// 重试」各调用一次，把竞态窗口关闭到最小；文件已是空根时静默跳过。
fn reset_active_profile_root(app_handle: &tauri::AppHandle) {
    let profile_root = crate::service::profile::profile_dir_of(
        app_handle,
        &crate::service::profile::active_profile(app_handle),
    );
    if !profile_root.is_dir() {
        return;
    }
    let root_config = profile_root.join("cordis.yml");
    const PROFILE_ROOT_EMPTY: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    if std::fs::read_to_string(&root_config).ok().as_deref() != Some(PROFILE_ROOT_EMPTY) {
        if let Err(e) = std::fs::write(&root_config, PROFILE_ROOT_EMPTY) {
            log::warn!("PROFILE_ROOT_RESET_FAILED: {}: {e}", root_config.display());
        } else {
            log::info!(
                "Reset stale profile root before spawn: {}",
                root_config.display()
            );
        }
    }
}

/// 判断 dsh 早期退出是否命中「duplicate loader entry」竞态签名。
///
/// 竞态特征：exit code 1 且 stderr 含 `duplicate loader entry`（dsh-app-boot
/// 的 Include 把重复 bundle 行叠加进根树时抛出的 TypeError 文本，实测
/// `duplicate loader entry id: dsh-tauri-worktree`）。
#[cfg(windows)]
fn is_duplicate_loader_exit(exit_code: u32, stderr: &str) -> bool {
    exit_code == 1 && stderr.contains("duplicate loader entry")
}

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的 dsh 入口（本地核心优先，未检测到走预打包）
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    log::debug!("Checking Node.js path: {:?}", node_binary_path);
    if !node_binary_path.exists() {
        log::error!("Node.js not installed");
        return Err("NODE_NOT_FOUND: Node.js not installed".to_string());
    }
    log::debug!("Checking Harness path: {:?}", dsh_binary_path);
    if !dsh_binary_path.exists() {
        log::error!("Harness not installed");
        return Err("HARNESS_NOT_FOUND: Harness not installed".to_string());
    }

    // 从这里开始持有与核心切换共用的互斥锁：最终状态检查、启动守卫、残留清扫
    // 及新进程登记必须处于同一临界区，避免切换在检查后插入。
    let _transition_guard = super::process::acquire_core_transition().await?;

    // 避免重复启动（配合启动守卫，确保并发调用只拉起一个进程）
    if has_owned_process() {
        log::info!("Owned Harness process is already running, skipping launch");
        return Ok(());
    }
    if LAUNCH_GUARD
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!("Harness launch already in progress, skipping");
        return Ok(());
    }
    let _launch_guard = LaunchGuard;
    // 只有持有启动守卫的这条路径清扫残留：并发启动的其它调用已在守卫处返回，
    // 不会误杀刚拉起的进程。崩溃/强杀残留的孤儿 Harness 实例（不在
    // .harness.pid 标记中）持续占用配置端口与 dependencies/dsh 的文件句柄，
    // 不清扫会导致端口一路漂移（3080→…→3085，issue #91）并让后续目录互换
    // 失败（os error 32）。按命令行路径精确匹配本应用 dsh 服务，不会误杀
    // 用户其它 node 程序（debug 构建为 no-op，见 terminate_stale_harness_processes）。
    {
        let handle = app_handle.clone();
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
            terminate_stale_harness_processes(&handle);
        })
        .await
        {
            log::warn!(
                "failed to sweep stale Harness processes before launch at {}: {e}",
                dsh_binary_path.display()
            );
        }
    }

    // 端口自愈：自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口，
    // 在回落目标（用户手动端口 manual_port，否则默认端口）空闲时回落，避免
    // 端口只增不减、一路从 3080 漂到 3084+（issue #91）。先于
    // wait_for_port_release 探测：既然放弃旧端口，就无需等它释放。
    let heal_target = setting.manual_port.unwrap_or(config::default_port());
    let healed_port = resolve_heal_port(setting.port, heal_target, !is_port_in_use(heal_target));
    if healed_port != setting.port {
        log::info!(
            "Harness port healed from {} back to {} (no longer occupied)",
            setting.port,
            healed_port
        );
        setting.port = healed_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }

    // 端口冲突时从当前值开始逐个递增，并持久化最终选择供所有调用方复用。
    // 注意：上个会话的残留 dsh 进程刚被我们结束/清扫（sweep_orphan、stop、
    // stop_on_exit），TCP 端口释放存在短暂滞后——此刻立刻探测会把“刚释放的
    // 端口”误判为仍占用，从而把配置端口永久顶高（dev 热更新下 3081→3082→…
    // 一路漂移，表现为“端口持续累加 + 首次启动超时、刷新后恢复”）。先留出
    // 窗口等配置端口回落为空闲，再决定是否真的逐级递增。
    wait_for_port_release(setting.port).await;
    let available_port = find_available_port(setting.port)?;
    if available_port != setting.port {
        log::info!(
            "Harness port changed from {} to {} because the configured port is occupied",
            setting.port,
            available_port
        );
        setting.port = available_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }

    // 构造环境变量：隔离的 $DSH_HOME + 隐私默认（关闭遥测）
    let dsh_home = config::get_dsh_data_path(&app_handle);
    fs::create_dir_all(&dsh_home)
        .map_err(|e| format!("DSH_HOME_MKDIR_FAILED: create dsh home failed: {e}"))?;

    // Linux 起步前探测 inotify 监视上限：harness 服务（dsh web）用 chokidar 递归
    // 监视 profile 目录，上限过低会在启动一瞬间抛 ENOSPC 直接退出（issue #116）。
    // 进程无法自我调高该参数，这里只做告警（启动日志 + 读取 run logs 中的环境信息），
    // 前端据服务日志的 ENOSPC 特征给出「调高 fs.inotify.max_user_watches」的针对性提示。
    #[cfg(unix)]
    warn_if_inotify_watch_limit_low();

    // Windows 极简模式修复的自愈：插件已装入 profile 时确保 patch 挂载行与
    // minimal-win 用户 preset 落盘（幂等）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 terminal support apply failed: {e}");
    }
    // alpha 的 iframe 无法稳定完成 SameSite=Strict browser-session Cookie 交换：
    // 仅命中 alpha 鉴权锚点时跳过 browser-session 层，但保留 Host/Origin fence；
    // 旧核心无 alpha 锚点，patch_dsh 会安全跳过，不改变旧版行为。
    if let Err(e) = crate::service::patch::alpha_auth::apply(&app_handle) {
        log::warn!("alpha embedded auth patch failed: {e}");
    }
    // renderer 的 SlotOutlet 一行导出补丁（dsh-tauri-ui 设置侧边栏依赖）：只补
    // 活动核心的 dsh-client-ui-renderer lib/client.js，已含导出即跳过（幂等；核心
    // 换版本后自动重打，上游官方导出后自动退休）。最佳努力：失败只告警，不阻断
    // 启动——未打补丁时插件侧降级，官方设置 dialog 照常工作，绝不白屏。
    if let Err(e) = crate::service::patch::renderer::apply(&app_handle) {
        log::warn!("renderer SlotOutlet patch failed: {e}");
    }
    // Expose an id-based SessionStore.remove facade so plugins can perform a
    // real in-memory teardown instead of leaving deleted sessions ungrouped.
    if let Err(e) = crate::service::patch::session::apply(&app_handle) {
        log::warn!("SessionStore.remove patch failed: {e}");
    }
    // worktree 会话以隔离 cwd 执行，但产品归属仍是源 Workspace；放宽上游显式
    // attach 的 cwd 相等约束，其他 cwd 有效性校验保持不变。最佳努力且幂等。
    if let Err(e) = crate::service::patch::workspace::apply(&app_handle) {
        log::warn!("workspace worktree membership patch failed: {e}");
    }
    // 当前 DSH client-HMR 会卸载第三方插件却不重新挂载。debug 直接联接本地
    // 插件源码，故将 rebuilt 降级为自动刷新页面；release 保持上游行为。
    if let Err(e) = crate::service::patch::client_hmr::apply(&app_handle) {
        log::warn!("debug client plugin reload fallback patch failed: {e}");
    }
    // 预防性处理：pnpm 在无 TTY 环境（dsh-market 等子进程）下重装/更新插件时，
    // 清理/重建 node_modules 会触发交互确认并因无 TTY 直接中止
    // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），表现为插件更新失败。
    // 启动时确保 profile 的 .npmrc 写入 confirmModulesPurge=false（幂等、保留
    // 已有配置）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::ensure_profile_npmrc(&app_handle) {
        log::warn!("ensure profile .npmrc failed: {e}");
    }
    // 弃用插件自动卸载：`deprecated-plugins.json` 登记的社区插件若已安装，启动时
    // 自动移除（避免残留插件继续在 profile 里加载、甚至导致启动失败）。最佳努力：
    // 失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::uninstall_deprecated_plugins(&app_handle).await {
        log::warn!("uninstall deprecated plugins failed: {e}");
    }
    // 内置插件自愈：随包分发的内置插件（dsh-tauri 等）必须在服务进程加载插件
    // 前就绪——核对「已安装 + 安装路径指向当前捆绑目录」，未安装、路径不正确
    // 或用户卸载后重启，一律强制重装（见 service::plugin::internal）。最佳
    // 努力：失败只告警，不阻断启动（核心功能缺失是发布缺陷，由 prebuild 报错）。
    if let Err(e) = crate::service::plugin::ensure_internal_plugins(&app_handle).await {
        log::warn!("ensure internal plugins failed: {e}");
    }
    // 预装插件完整性自检：清单引用的预装插件若在 node_modules 缺失产物，服务
    // 启动时 loader 会对每个缺失插件抛 ERR_MODULE_NOT_FOUND 而整体失败（issue
    // #90，日志特征 `Cannot find package`）。用 `pnpm install` 以现有 manifest +
    // lockfile 为准重建依赖图修复；修复失败只告警并给缺失插件记录错误标记
    // （启动失败场景由前端 recovery 对话框兜底，见 service::plugin::recovery）。
    if let Err(e) = crate::service::plugin::ensure_preset_plugins(&app_handle).await {
        log::warn!("ensure preset plugins failed: {e}");
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "DSH_HOME".to_string(),
        dsh_home.to_string_lossy().into_owned(),
    );
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());
    // 把服务实际使用的 node 路径显式交给子进程（pnpm/dsh shim 的 DSH_NODE
    // 优先）：市场（dsh-market）等子进程经 PATH 解析 node 可能与桌面端预检
    // 不一致（相对 PATH 条目 / junction / 子进程 PATH 布局差异），导致 pnpm
    // shim 报 "Node.js runtime not found"（issue #121，与 build_plugin_envs
    // 的注入保持一致）。先规范化为绝对路径：相对路径在子进程 CWD 下会解析
    // 到错误位置；已存在（上面校验过）的 node 可安全 canonicalize。用
    // dunce::canonicalize 而不是 std::fs::canonicalize：后者在 Windows 上会
    // 返回 `\\?\` verbatim 前缀，cmd.exe 无法直接启动这种路径，导致 pnpm/dsh
    // shim 报 "The system cannot find the path specified."。
    let node_abs =
        dunce::canonicalize(&node_binary_path).unwrap_or_else(|_| node_binary_path.clone());
    envs.insert(
        "DSH_NODE".to_string(),
        node_abs.to_string_lossy().into_owned(),
    );

    // 扩展 PATH，让 dsh 及其子进程能找到 node 与桌面端自动配置的 Git；Windows
    // 上再注入 Git Bash 的 bin 目录：persistent bash（--noprofile --norc）不执行
    // profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    // 前置应用自身的 shim 目录，使市场（dsh-market）及其子进程通过名字解析的
    // `pnpm`/`dsh` 都命中桌面端 shim，从而受桌面端 pnpm 选版策略管辖
    // （轻量缓解，issue #69 系列）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![crate::service::cli::get_bin_dir(&app_handle)];
            paths.push(node_dir.to_path_buf());
            if let Some(git_dir) = config::get_git_cmd_dir(&app_handle) {
                log::debug!(
                    "harness service Git PATH prepend: {}",
                    git_dir.to_string_lossy()
                );
                paths.push(git_dir);
            }
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // GUI 进程可能启动在 pnpm 安装之前，继承的 PATH 因而没有 npm 全局目录。
    // 直接注入探测到的绝对路径，避免 dsh-market 的 pnpm --version 落到自身 shim
    // 后又因 PATH 看不到真正的 pnpm（issue #139）。
    if let Some(user_pnpm) = crate::service::cli::find_user_pnpm(&app_handle) {
        // Unix mise shim 依赖调用路径中的 argv[0]；只做字面绝对化，不能解析
        // `pnpm -> mise` 链接。Windows 仍由同一辅助函数处理连接点与 `\\?\`。
        if let Some(pnpm_value) = crate::service::cli::pnpm_env_value(
            &user_pnpm,
            &crate::service::cli::get_bin_dir(&app_handle),
        ) {
            envs.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    // 让市场子进程的 pnpm 与桌面端同一套受控策略（store 主版本感知、避免落到系统
    // homebrew pnpm）。与插件安装路径的 ensure_pnpm 版本感知一致，但启动阶段绝不
    // 触发下载；捆绑版未安装或与 store 不匹配时不注入（交由用户 pnpm）。
    // 最佳努力：失败只告警，不阻断启动。
    if crate::service::plugin::harness_prefer_bundled_pnpm(&app_handle) {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }

    // 日志文件（前端日志面板读取）。
    // 每次真实启动前轮转：只保留最近 3 次启动的日志，旧文件后退为
    // `dsh-web.log.1` / `dsh-web.log.2`，避免单文件随多次启动无限增长。
    let log_path = config::get_service_log_path(&app_handle);
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("LOG_DIR_MKDIR_FAILED: create log dir failed: {e}"))?;
    rotate_service_log(&log_path, 3);

    // rc.8 起 `dsh web` 默认在系统浏览器打开 UI；桌面端内嵌 WebView，不需要
    // 浏览器，追加 `--no-open` 关闭（老版本无此标志时按版本判定不传）。
    let no_open = web_supports_no_open_flag(&app_handle, &dsh_binary_path);

    log::info!("Starting Harness process");

    // dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
    // `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
    // tree）。上一轮被杀/崩溃的 dsh 若在「新进程 prepareProfile 重置之后、
    // Include 读取之前」完成回写，新 boot 会读到已含 bundle 组合行的文件，
    // 再叠加同一批 patch → duplicate loader entry（本会话实测特征
    // `duplicate loader entry id: dsh-tauri-worktree`）。spawn 前最后一刻重置
    // profile 根关闭常见窗口；回写恰好落在探测窗口内的残余竞态由下方
    // Windows 分支的「早期退出重试」兜底。
    reset_active_profile_root(&app_handle);

    // Windows 打包版是 GUI 进程（没有控制台）。直接以 CREATE_NO_WINDOW 启动
    // node 会让 dsh 派生的子进程各自新建可见控制台窗口（频繁闪烁 cmd 黑窗），
    // 因此 Windows 上改用“隐藏控制台”方式启动，见 win_spawn 模块。
    let active_profile = crate::service::profile::active_profile(&app_handle);
    let spawn_result = {
        #[cfg(windows)]
        {
            use std::io::{BufReader, Read};
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, WaitForSingleObject, INFINITE,
            };

            let mut args: Vec<OsString> = vec![
                dsh_binary_path.as_os_str().to_os_string(),
                OsString::from("--profile"),
                OsString::from(active_profile.as_str()),
                OsString::from("--host"),
                OsString::from("127.0.0.1"),
                OsString::from("--port"),
                OsString::from(setting.port.to_string()),
            ];
            if no_open {
                args.push(OsString::from("--no-open"));
            }

            // 只负责 spawn 并返回管道/PID/句柄：探测与重试期间不登记、不挂
            // 监视线程——只有最终采用的那个进程才登记，否则旧监视线程会通过
            // `on_owned_process_exit` 把刚启动的新进程误当作已退出而回落状态。
            let spawn_harness =
                || -> std::io::Result<(std::fs::File, std::fs::File, u32, HANDLE)> {
                    super::win_spawn::spawn_with_hidden_console_owned(
                        &node_binary_path,
                        &args,
                        Some(&config::get_dsh_install_path(&app_handle)),
                        &envs,
                    )
                };

            // 早期退出重试：崩溃的上一轮 dsh 回写 `cordis.yml` 落在「新进程
            // prepareProfile 重置之后、Include 读取之前」时，新 boot 会把已含
            // bundle 组合行的 root 再叠加同一批 patch → `duplicate loader
            // entry`（实测 exit code 1）。spawn 前重置只覆盖常见窗口，这里在
            // spawn 后探测 ≤2.5s：命中签名则丢弃实例、重置 profile 根并重试
            //（最多 3 次，第二次 boot 基于干净状态必然成功）；仍在运行则视为
            // 健康立即放行登记。探测期间最长阻塞 2.5s，之后才返回给调用方。
            let mut attempt = 0u32;
            let mut outcome = spawn_harness();
            loop {
                attempt += 1;
                let (stdout, stderr, pid, handle) = match outcome {
                    Ok(spawned) => spawned,
                    Err(error) => {
                        // spawn 自身失败（非竞态）：保持 Err 交给下方 map 传播
                        outcome = Err(error);
                        break;
                    }
                };
                let wait = unsafe { WaitForSingleObject(handle, 2500) };
                if wait == WAIT_TIMEOUT {
                    // 健康：进程仍在运行，交给下方登记 + 监视线程。
                    outcome = Ok((stdout, stderr, pid, handle));
                    break;
                }
                // 已提前退出：读 stderr 判断是否命中竞态签名。
                let mut exit_code: u32 = 0;
                let got_exit_code = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
                let mut stderr_text = String::new();
                let mut stderr_reader = BufReader::new(stderr);
                let _ = Read::read_to_string(&mut stderr_reader, &mut stderr_text);
                let hit_duplicate =
                    got_exit_code && is_duplicate_loader_exit(exit_code, &stderr_text);
                if hit_duplicate && attempt < 3 {
                    // 丢弃首个失败实例：从未登记，句柄由本分支关闭（此时没有
                    // 监视线程，不存在重复 close）。
                    drop(stdout);
                    unsafe { CloseHandle(handle) };
                    log::warn!(
                        "DUPLICATE_LOADER_ENTRY: dsh exited early with duplicate loader entry \
                         (pid={pid}, code={exit_code}); resetting profile root and relaunching \
                         (attempt {attempt}/3)"
                    );
                    reset_active_profile_root(&app_handle);
                    outcome = spawn_harness();
                    continue;
                }
                // 非签名提前退出或重试耗尽：走正常路径——已捕获的 stderr 补写
                // 日志避免失败原因丢失，句柄保持有效交给监视线程等待并关闭。
                for line in stderr_text.lines() {
                    log::warn!(target: "dsh", "{}", line);
                }
                outcome = Ok((stdout, stderr_reader.into_inner(), pid, handle));
                break;
            }

            outcome.map(|(stdout, stderr, pid, handle)| {
                // PID 与句柄作为整体一次登记，与退出清理（take 一并取出）配对
                let handle_value = handle as usize;
                set_owned_process_with_handle(pid, handle_value);
                let exit_app_handle = app_handle.clone();
                std::thread::spawn(move || unsafe {
                    let process_handle = handle_value as HANDLE;
                    WaitForSingleObject(process_handle, INFINITE);
                    // 进程确已退出：清空持有 PID 并把 Status 从 Running 回落为
                    // Stopped（原有实现只清 PID、状态永远停留在 Running）。
                    // 仅当该 PID 仍是当前登记才取出——旧监视线程不会误清新进程。
                    // take 返回值里的句柄由本线程负责关闭（不会与
                    // terminate_owned_process 重复 close——进程已 exit，
                    // 通常是本线程取走）。
                    let owned = on_owned_process_exit(&exit_app_handle, pid, |owned| {
                        let handle = owned.handle as HANDLE;
                        let mut exit_code: u32 = 0;
                        (GetExitCodeProcess(handle, &mut exit_code) != 0)
                            .then_some(i64::from(exit_code))
                    });
                    if let Some(owned) = owned {
                        let h = owned.handle as HANDLE;
                        CloseHandle(h);
                    }
                });
                (Some(stdout), Some(stderr), pid)
            })
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new(&node_binary_path);
            cmd.arg(&dsh_binary_path)
                .arg("--profile")
                .arg(active_profile.as_str())
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(&setting.port.to_string());
            if no_open {
                cmd.arg("--no-open");
            }
            cmd.envs(&envs)
                .current_dir(config::get_dsh_install_path(&app_handle))
                // 核心修正：提供一个空的 stdin 防止 setRawMode 报错
                .stdin(Stdio::null())
                // 使用管道捕获输出，以便在子线程中读取
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                // 独立进程组让停止操作只影响 Harness 及其后代。
                .process_group(0);
            cmd.spawn().map(|mut child| {
                let pid = child.id();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                set_owned_process(pid);
                let exit_app_handle = app_handle.clone();
                std::thread::spawn(move || {
                    let code = child.wait().ok().and_then(|status| status.code());
                    // 进程确已退出：清空持有 PID 并把 Status 从 Running 回落为 Stopped
                    // （Unix 无进程句柄可关闭，忽略返回的进程记录）。
                    // 仅当该 PID 仍是当前登记才取出——旧监视线程不会误清新进程。
                    let _ = on_owned_process_exit(&exit_app_handle, pid, |_| code.map(i64::from));
                });
                (stdout, stderr, pid)
            })
        }
    };

    match spawn_result {
        Ok((stdout, stderr, pid)) => {
            log::info!(
                "Harness process started successfully: pid={pid}, port={}",
                setting.port
            );
            // 记录 PID+端口供下次启动清扫崩溃残留的孤儿实例（见 sweep_orphan_harness）
            persist_harness_pid(&app_handle, pid, setting.port);
            spawn_output_readers(stdout, stderr, log_path);
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to start process: {}", e);
            Err(format!("PROCESS_START_FAILED: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn occupied_port_advances_to_a_free_port() {
        let mut checked = Vec::new();
        let selected = find_available_port_by(3080, |port| {
            checked.push(port);
            port < 3082
        })
        .expect("find next free port");

        assert_eq!(selected, 3082);
        assert_eq!(checked, vec![3080, 3081, 3082]);
    }

    #[test]
    fn occupied_port_reports_exhaustion_at_max_port() {
        let error = find_available_port_by(u16::MAX, |_| true).expect_err("port exhaustion");
        assert!(error.starts_with("PORT_EXHAUSTED:"));
    }

    /// 模拟“上个会话残留进程刚被杀、端口仍在释放”的场景：先占用端口，随后在
    /// 另一线程释放。验证 `wait_for_port_release` 在端口回落后立即返回，而不是
    /// 等到完整等待窗口——这正是避免端口永久顶高（dev 热更新下 3081→3082→…）
    /// 的关键行为。
    #[tokio::test]
    async fn wait_for_port_release_returns_shortly_after_port_is_released() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind held test port");
        let held = listener.local_addr().expect("read held port").port();

        // 端口此刻确实被占用（模拟残留进程仍在监听）
        assert!(is_port_in_use(held));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(listener);
        });

        let started = std::time::Instant::now();
        wait_for_port_release(held).await;
        // 端口 150ms 后释放 + 80ms 轮询间隔，应远小于 1.5s 等待上限
        assert!(
            started.elapsed() < std::time::Duration::from_millis(800),
            "wait_for_port_release should return shortly after the port is released, not wait the full window"
        );
        releaser.join().expect("port releaser thread");
    }

    #[test]
    fn no_open_supported_on_rc8_and_later() {
        assert!(version_supports_no_open("0.1.0-rc.8"));
        assert!(version_supports_no_open("0.1.0-rc.9"));
        // 基础版本更大的新版本：0.1.1-rc.1 的 rc 号（1）虽小于 8，但晚于
        // 0.1.0-rc.8，同样支持 --no-open（只比 rc 号会把这里误判为旧版）
        assert!(version_supports_no_open("0.1.1-rc.1"));
        assert!(version_supports_no_open("0.1.2-rc.1"));
        // 稳定版必然晚于 rc.8
        assert!(version_supports_no_open("0.1.0"));
        assert!(version_supports_no_open("0.2.0"));
        assert!(version_supports_no_open("1.0.0"));
    }

    #[test]
    fn no_open_absent_before_rc8() {
        assert!(!version_supports_no_open("0.1.0-rc.7"));
        assert!(!version_supports_no_open("0.1.0-rc.0"));
        // 基础版本更早的 rc 系列一律不支持
        assert!(!version_supports_no_open("0.0.1-rc.5"));
        assert!(!version_supports_no_open("0.0.9-rc.99"));
    }

    #[test]
    fn no_open_unknown_version_is_conservative() {
        assert!(!version_supports_no_open(""));
        // rc 号缺失：`0.1.0-rc` 的预发布 [rc] 短于 [rc, 8]，判为早于 rc.8
        assert!(!version_supports_no_open("0.1.0-rc"));
        // 不完整/非法版本号（缺 patch、带 v 前缀、无 semver 结构）：无法解析
        assert!(!version_supports_no_open("0.1"));
        assert!(!version_supports_no_open("v0.1.0"));
        assert!(!version_supports_no_open("not-a-version"));
    }

    /// 「duplicate loader entry」竞态签名的判定：只认 exit code 1 + stderr 含
    /// 该文本（实测失败日志：
    /// `Error: dsh: plugin tree failed to load: failed to apply loader entry
    /// include (cordis:include): duplicate loader entry id: dsh-tauri-worktree`）。
    #[cfg(windows)]
    #[test]
    fn duplicate_loader_exit_signature_matches_observed_error() {
        let stderr = "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: dsh-tauri-worktree\nTypeError: duplicate loader entry id: dsh-tauri-worktree\n    at EntryGroup.update (...)";
        assert!(is_duplicate_loader_exit(1, stderr));
        // 其他退出码、无关错误或没有该文本的启动失败不命中
        assert!(!is_duplicate_loader_exit(0, stderr));
        assert!(!is_duplicate_loader_exit(2, stderr));
        assert!(!is_duplicate_loader_exit(
            1,
            "Error: EADDRINUSE: address already in use"
        ));
        assert!(!is_duplicate_loader_exit(1, ""));
    }

    /// 端口自愈（issue #91）：自动避让递增遗留的非默认端口，在回落目标空闲时
    /// 回落到目标（默认端口或用户手动端口），回落目标被占时维持当前端口。
    #[test]
    fn heal_port_returns_target_when_free() {
        // 自动递增遗留 3084，默认 3080 空闲 → 回落默认端口
        assert_eq!(resolve_heal_port(3084, 3080, true), 3080);
        // 用户手动 9090 空闲 → 回落用户值
        assert_eq!(resolve_heal_port(9091, 9090, true), 9090);
    }

    #[test]
    fn heal_port_keeps_current_when_target_busy_or_aligned() {
        // 回落目标被占 → 维持当前端口（留给 find_available_port 逐级递增）
        assert_eq!(resolve_heal_port(3084, 3080, false), 3084);
        // 当前端口即回落目标（已是最优）→ 不变
        assert_eq!(resolve_heal_port(3080, 3080, true), 3080);
        assert_eq!(resolve_heal_port(3080, 3080, false), 3080);
    }
}
