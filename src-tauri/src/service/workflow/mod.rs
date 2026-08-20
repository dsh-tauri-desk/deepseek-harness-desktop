pub mod status;
pub mod utils;
pub(crate) mod win_inspector;
#[cfg(windows)]
pub(crate) mod win_spawn;

use crate::config;
use crate::service::download;
use crate::service::workflow::utils::{is_port_in_use, spawn_output_readers};
use std::collections::HashMap;

#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::Manager;

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
static LAUNCH_GUARD: AtomicBool = AtomicBool::new(false);
/// 当前进程内由桌面端创建的 Harness 根进程 PID；0 表示没有持有的实例。
static OWNED_PROCESS_ID: AtomicU32 = AtomicU32::new(0);
/// dsh 完成 Loader 组合并打印服务地址后才视为启动就绪。
static OWNED_PROCESS_READY: AtomicBool = AtomicBool::new(false);
/// Windows 进程句柄用于确认 PID 仍指向原进程，消除 PID 复用误杀窗口。
#[cfg(windows)]
static OWNED_PROCESS_HANDLE: AtomicUsize = AtomicUsize::new(0);

struct LaunchGuard;

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCH_GUARD.store(false, Ordering::SeqCst);
    }
}

/// 从起始端口向上查找第一个空闲端口，绝不结束未知的端口占用进程。
fn find_available_port(start: u16) -> Result<u16, String> {
    let mut port = start;
    loop {
        if !is_port_in_use(port) {
            return Ok(port);
        }
        log::warn!("Port {port} is occupied, trying the next port");
        port = port.checked_add(1).ok_or_else(|| {
            "PORT_EXHAUSTED: no available TCP port after the configured port".to_string()
        })?;
    }
}

/// 只结束本应用当前进程创建并仍持有的 Harness 进程树。
fn terminate_owned_process() {
    OWNED_PROCESS_READY.store(false, Ordering::SeqCst);
    let pid = OWNED_PROCESS_ID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        const WAIT_TIMEOUT_CODE: u32 = 0x0000_0102;
        let handle_value = OWNED_PROCESS_HANDLE.swap(0, Ordering::SeqCst);
        if handle_value == 0 {
            return;
        }
        let handle = handle_value as windows_sys::Win32::Foundation::HANDLE;
        // 真实句柄已结束说明 PID 可能已复用，此时绝不调用 taskkill。
        if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT_CODE {
            unsafe { CloseHandle(handle) };
            return;
        }
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        if let Err(e) = cmd.output() {
            log::error!("Failed to stop owned Harness process {pid}: {e}");
        }
        unsafe {
            WaitForSingleObject(handle, 5_000);
            CloseHandle(handle);
        }
    }

    #[cfg(unix)]
    {
        // Harness 根进程启动在独立进程组中，负 PID 只作用于该进程树。
        let group = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", "--", &group]).output();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = Command::new("kill").args(["-KILL", "--", &group]).output();
    }
}

pub fn has_owned_process() -> bool {
    OWNED_PROCESS_ID.load(Ordering::SeqCst) != 0
}
/// dsh 已完成插件 Loader 组合并宣布 Web 服务地址。
pub fn is_owned_process_ready() -> bool {
    has_owned_process() && OWNED_PROCESS_READY.load(Ordering::SeqCst)
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let dsh_binary_path = config::get_dsh_binary_path(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
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

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let dsh_binary_path = config::get_dsh_binary_path(&app_handle);

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
    OWNED_PROCESS_READY.store(false, Ordering::SeqCst);


    // 端口冲突时从当前值开始逐个递增，并持久化最终选择供所有调用方复用。
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
    fs::create_dir_all(&dsh_home).map_err(|e| format!("create dsh home failed: {e}"))?;

    // Windows 极简模式修复的自愈：插件已装入 profile 时确保 patch 挂载行与
    // minimal-win 用户 preset 落盘（幂等）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 terminal support apply failed: {e}");
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "DSH_HOME".to_string(),
        dsh_home.to_string_lossy().into_owned(),
    );
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());

    // 扩展 PATH，让 dsh 及其子进程能找到 node；Windows 上再注入 Git Bash 的
    // bin 目录：persistent bash（--noprofile --norc）不执行 profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![node_dir.to_path_buf()];
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // 日志文件（前端日志面板读取）
    let log_path = config::get_service_log_path(&app_handle);
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("create log dir failed: {e}"))?;

    log::info!("Starting Harness process");

    // Windows 打包版是 GUI 进程（没有控制台）。直接以 CREATE_NO_WINDOW 启动
    // node 会让 dsh 派生的子进程各自新建可见控制台窗口（频繁闪烁 cmd 黑窗），
    // 因此 Windows 上改用“隐藏控制台”方式启动，见 win_spawn 模块。
    let spawn_result = {
        #[cfg(windows)]
        {
            let args: Vec<OsString> = vec![
                dsh_binary_path.as_os_str().to_os_string(),
                OsString::from("--profile"),
                OsString::from("web"),
                OsString::from("--host"),
                OsString::from("127.0.0.1"),
                OsString::from("--port"),
                OsString::from(setting.port.to_string()),
            ];
            win_spawn::spawn_with_hidden_console_owned(
                &node_binary_path,
                &args,
                Some(&config::get_dsh_install_path(&app_handle)),
                &envs,
            )
            .map(|(stdout, stderr, pid, handle)| {
                OWNED_PROCESS_ID.store(pid, Ordering::SeqCst);
                // 持有真实进程句柄直到退出；退出后仅在 PID 仍匹配时清空，避免复用。
                let handle_value = handle as usize;
                OWNED_PROCESS_HANDLE.store(handle_value, Ordering::SeqCst);
                std::thread::spawn(move || unsafe {
                    use windows_sys::Win32::Foundation::CloseHandle;
                    use windows_sys::Win32::System::Threading::{
                        GetExitCodeProcess, WaitForSingleObject, INFINITE,
                    };
                    let process_handle = handle_value as windows_sys::Win32::Foundation::HANDLE;
                    WaitForSingleObject(process_handle, INFINITE);
                    // 记录退出码：启动即崩溃（插件冲突等）时前端据此快速失败，
                    // 退出码也便于诊断问题
                    let mut exit_code: u32 = 0;
                    if GetExitCodeProcess(process_handle, &mut exit_code) != 0 {
                        log::warn!("Owned Harness process {pid} exited with code {exit_code}");
                    } else {
                        log::warn!("Owned Harness process {pid} exited (exit code unavailable)");
                    }
                    let owns_process = OWNED_PROCESS_ID
                        .compare_exchange(
                            pid,
                            0,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok();
                    if owns_process {
                        OWNED_PROCESS_READY.store(false, Ordering::SeqCst);
                    }
                    let owns_handle = OWNED_PROCESS_HANDLE
                        .compare_exchange(handle_value, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok();
                    if owns_handle {
                        CloseHandle(process_handle);
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
                .arg("web")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(&setting.port.to_string())
                .envs(&envs)
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
                OWNED_PROCESS_ID.store(pid, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let code = child.wait().ok().and_then(|status| status.code());
                    // 记录退出码：启动即崩溃（插件冲突等）时前端据此快速失败
                    if let Some(code) = code {
                        log::warn!("Owned Harness process {pid} exited with code {code}");
                    } else {
                        log::warn!("Owned Harness process {pid} exited (no exit code)");
                    }
                    let owns_process = OWNED_PROCESS_ID
                        .compare_exchange(
                            pid,
                            0,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok();
                    if owns_process {
                        OWNED_PROCESS_READY.store(false, Ordering::SeqCst);
                    }
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
            let on_stdout_line: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|line: &str| {
                if line.trim_start().starts_with("dsh web:") {
                    OWNED_PROCESS_READY.store(true, Ordering::SeqCst);
                }
            });
            spawn_output_readers(stdout, stderr, log_path, Some(on_stdout_line));
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to start process: {}", e);
            Err(format!("PROCESS_START_FAILED: {e}"))
        }
    }
}

/// 停止 Harness 服务
pub async fn stop(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Stopping Harness service...");
    // 重置启动守卫，确保后续 launch 可以重新拉起；仅结束持有的根进程树。
    LAUNCH_GUARD.store(false, Ordering::SeqCst);
    terminate_owned_process();

    // 给系统一点时间释放端口 (重要！)
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    status::set_status(status::Status::Stopped);
    status::emit_status(&app_handle);
    Ok(())
}

/// 应用退出时同步回收 Harness 进程。
///
/// 退出路径上不更新状态、不做异步等待，只结束当前应用持有的 Harness 进程树。
pub fn stop_on_exit(_app_handle: tauri::AppHandle, _port: u16) {
    terminate_owned_process();
}

/// 安装环境（Node.js 运行时 + 打包的 Harness 发行版）
pub async fn install(
    app_handle: &tauri::AppHandle,
    mut dsh_latest: Option<download::LatestDshPkg>,
) -> Result<(), String> {
    log::info!("Starting installation process");

    // 安装前先停止本应用持有的 Harness 服务：运行中的 node 进程会把
    // 原生模块 DLL（如 sharp 的 libvips-42.dll）加载进内存并锁住文件，
    // 不停止的话覆盖解压必然失败（Windows os error 32）。
    // 进程归属以启动时记录的 PID 为准，不根据端口结束未知程序。
    if has_owned_process() {
        log::info!("Stopping running Harness service before installation");
        stop(app_handle.clone()).await?;

    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    log::debug!("Main window obtained");
    // 3 个任务 × 下载/解压 2 个阶段
    let mut tracker = download::ProgressTracker::new(&window, 6);
    let tasks: Vec<Box<dyn download::Installable>> = vec![
        Box::new(download::Nodejs),
        Box::new(download::Dsh),
        Box::new(download::Pnpm),
    ];
    log::info!("Task list created, {} tasks total", tasks.len());

    for (index, task) in tasks.iter().enumerate() {
        log::debug!("Processing task {}/{}", index + 1, tasks.len());
        // 已安装但 commit 与最新 release 不一致时强制重新下载
        let outdated = index == 1
            && dsh_latest.as_ref().is_some_and(|info| {
                config::get_dsh_pkg_commit(app_handle).as_deref() != Some(info.commit.as_str())
            });
        if task.check_installed(app_handle) && !outdated {
            log::debug!(
                "Task {} already installed and up to date, skipping",
                index + 1
            );
            tracker.skip_phases(2);
            continue;
        }

        log::info!("Task {} not installed, starting installation", index + 1);

        // 1. 下载
        tracker.start_phase(
            "download",
            &format!(
                "{} {}",
                config::i18n::t("install.downloading"),
                task.title()
            ),
        );
        // 下载 URL 对 dsh 也是完全确定可算的（DSH_CORE_URL + 平台文件名），
        // 无需依赖 GitHub API 元数据；api.github.com 限流/被代理拦截时
        // （mac 首次启动常见）仍能拿到真实下载地址，避免整次安装被瞬时失败卡死。
        let url = task.get_download_url()?;
        log::debug!("Download URL: {}", url);
        // 取文件名用于解压类型判定；下载 URL 正常必含 '/'，但这里不 panic，
        // 防御性兜底为空串（后续 ensure_extract 会因无法判定类型而报错返回，
        // 不再让进程崩溃）。
        let name = url.rsplit('/').next().unwrap_or("").to_string();
        log::debug!("File name: {}", name);
        let buffer = download::download_file(&tracker, url).await?;
        log::info!("Download completed, file size: {} bytes", buffer.len());
        let expected_digest = match index {
            0 => download::fetch_node_sha256(task.get_download_url()?.as_str()).await?,
            1 => {
                // dsh 的 SHA-256 digest 只能来自 GitHub release asset 元数据
                // （安全设计，见 dsh_INTEGRITY_UNAVAILABLE）。首次安装时该元数据
                // 可能因 api.github.com 限流/网络抖动而缺失（mac 首次启动常见，
                // issue #31），这里带退避重取，避免启动被瞬时失败卡死。
                if dsh_latest.is_none() {
                    for attempt in 0..3 {
                        match download::fetch_latest_dsh_pkg_info().await {
                            Ok(info) => {
                                dsh_latest = Some(info);
                                break;
                            }
                            Err(e) if attempt < 2 => {
                                log::warn!(
                                    "Retrying dsh release metadata fetch ({}/3), will retry: {}",
                                    attempt + 1,
                                    e
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    500 * (attempt as u64 + 1),
                                ))
                                .await;
                            }
                            Err(e) => {
                                return Err(format!(
                                    "DSH_INTEGRITY_UNAVAILABLE: 无法获取 Harness 发行版的完整性校验信息（{}），请检查网络后重试",
                                    e
                                ));
                            }
                        }
                    }
                }
                dsh_latest
                    .as_ref()
                    .map(|info| info.digest.clone())
                    .ok_or_else(|| {
                        "DSH_INTEGRITY_UNAVAILABLE: trusted release digest is required".to_string()
                    })?
            }
            2 => config::PNPM_SHA256.to_string(),
            _ => return Err("INSTALL_TASK_INVALID: unknown install task".to_string()),
        };
        download::verify_sha256(&buffer, &expected_digest)?;
        log::info!("Download integrity verified for task {}", index + 1);
        tracker.end_phase();

        // 2. 解压
        tracker.start_phase(
            "extract",
            &format!("{} {}", config::i18n::t("install.extracting"), task.title()),
        );
        let dest = task.get_install_path(app_handle);
        log::debug!("Installation path: {:?}", dest);
        download::ensure_extract(&tracker, name, buffer, dest)?;
        log::info!("Extraction completed");
        tracker.end_phase();

        // 记录本次安装对应的 release tag 与 commit，供下次启动比对
        if index == 1 {
            if let Some(info) = &dsh_latest {
                config::set_dsh_pkg_commit(app_handle, info.commit.clone());
                config::set_dsh_pkg_tag(app_handle, info.tag.clone());
            }
        }
    }

    log::info!("All installation tasks completed");
    tracker.update(
        100.0,
        config::i18n::t("install.done"),
        "All tasks completed".into(),
    );

    Ok(())
}

pub async fn proxy_health_check(port: u16) -> Result<String, String> {
    if !has_owned_process() {
        return Err("HARNESS_NOT_OWNED: no Harness process is owned by this app".to_string());
    }
    if !is_owned_process_ready() {
        return Err("HARNESS_NOT_READY: Harness process is still loading plugins".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(config::HEALTH_CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;

    for endpoint in [
        format!("http://127.0.0.1:{port}/"),
        format!("http://127.0.0.1:{port}/healthz"),
    ] {
        match client.get(&endpoint).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if status.is_success() {
                    return Ok(format!(
                        "healthy - {status} - {}",
                        body.chars().take(80).collect::<String>()
                    ));
                }
            }
            Err(err) => {
                log::debug!("Health check {endpoint}: {err}");
            }
        }
    }
    Err("HARNESS_NOT_READY: Harness service is not ready".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn occupied_port_advances_to_a_free_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind occupied test port");
        let occupied = listener.local_addr().expect("read occupied port").port();
        let selected = find_available_port(occupied).expect("find next free port");
        assert!(selected > occupied);
        assert!(!is_port_in_use(selected));
    }
}
