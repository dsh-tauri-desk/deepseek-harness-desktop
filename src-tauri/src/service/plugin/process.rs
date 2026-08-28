//! dsh 子进程执行：启动 `dsh plugin` 进程并等待退出，输出逐行转发为事件。
//!
//! Windows 打包版是 GUI 进程（无控制台），直接以 CREATE_NO_WINDOW 启动会让
//! dsh 派生的子进程各建可见控制台窗口（黑窗闪烁），因此复用
//! `service/workflow/win_spawn` 的隐藏控制台方案并额外跟踪进程句柄以等待退出；
//! Unix 上直接以管道捕获标准输出/错误。

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, WebviewWindow};

use crate::service::workflow;
#[cfg(not(windows))]
use std::process::{Command, Stdio};

use super::output::{self, CapturedOutput};

/// 前端监听的控制台事件名（进程输出行）
pub(crate) const PREINSTALL_LOG_EVENT: &str = "preinstall-log";
/// 插件安装、升级和卸载进程的硬超时。
pub(crate) const PLUGIN_PROCESS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_LOG_EVENTS_PER_SECOND: usize = 120;

/// 进程输出行事件载荷
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallLogPayload {
    pub line: String,
}

/// 当前正在运行的 `dsh plugin` 子进程 PID（无进行中安装时为 None）。
///
/// `cancel`（跨平台）用它结束安装进程树；安装结束/失败后必须复位，
/// 防止把「下一个安装」或无关进程误杀。
///
/// 仅在 Unix 被 `cancel` 使用（Windows 取消安装走 taskkill 按命令行匹配），
/// 故 Windows 下按项目约定允许 dead_code。
static ACTIVE_PLUGIN_PID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

fn active_pid_lock() -> &'static Mutex<Option<u32>> {
    ACTIVE_PLUGIN_PID.get_or_init(|| Mutex::new(None))
}

/// 当前进行中安装的根进程 PID（取消安装用）。
pub(crate) fn active_plugin_pid() -> Option<u32> {
    *active_pid_lock().lock().unwrap_or_else(|e| e.into_inner())
}

/// 记录/清除当前安装进程 PID（guard-drop 模式，作用域结束自动复位）。
struct PidGuard;

impl PidGuard {
    fn set(pid: u32) {
        *active_pid_lock().lock().unwrap_or_else(|e| e.into_inner()) = Some(pid);
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        *active_pid_lock().lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Windows 进程句柄包装：原始句柄是 `*mut c_void`（非 Send），
/// 但 `WaitForSingleObject`/`GetExitCodeProcess` 均为线程安全的系统调用，
/// 包一层以安全地移入 `spawn_blocking` 等待进程退出。
#[cfg(windows)]
struct WaitableHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for WaitableHandle {}

/// 启动 `dsh plugin` 进程并等待结束，返回 `(退出码, 捕获的完整输出)`。
///
/// 输出仍然逐行实时转发为 `preinstall-log` 事件（供前端进度反馈），同时把
/// 全部行追加进共享缓冲区并返回——安装失败时 pnpm 会在错误里印出
/// `allowBuilds:` 允许键（git depPath / 被忽略的构建包名），调用方需要这段
/// 文本去解析并重试。
pub(crate) async fn run_plugin_process(
    node: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &HashMap<String, String>,
    window: &WebviewWindow,
) -> Result<(i32, String), String> {
    let captured = output::new_capture();
    let log_limiter = Arc::new(Mutex::new(LogEventLimiter::new()));

    #[cfg(windows)]
    {
        let (stdout, stderr, handle) =
            workflow::win_spawn::spawn_with_hidden_console_tracked(node, args, Some(cwd), envs)
                .map_err(|e| format!("PREINSTALL_SPAWN: {e}"))?;

        spawn_line_emitter(
            stdout,
            window.clone(),
            captured.clone(),
            log_limiter.clone(),
        );
        spawn_line_emitter(stderr, window.clone(), captured.clone(), log_limiter);

        let handle = WaitableHandle(handle);
        let pid = unsafe { windows_sys::Win32::System::Threading::GetProcessId(handle.0) };
        if pid == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle.0) };
            return Err("PREINSTALL_WAIT: unable to identify plugin process".to_string());
        }
        PidGuard::set(pid);
        let _pid_guard = PidGuard;
        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, WaitForSingleObject, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
            };
            let handle = handle;
            unsafe {
                let wait = WaitForSingleObject(
                    handle.0,
                    PLUGIN_PROCESS_TIMEOUT.as_millis().min(u32::MAX as u128) as u32,
                );
                if wait == WAIT_TIMEOUT {
                    workflow::kill_pid_tree(pid);
                    let terminated = WaitForSingleObject(handle.0, 5_000);
                    CloseHandle(handle.0);
                    if terminated == WAIT_TIMEOUT {
                        return Err(
                            "PREINSTALL_TIMEOUT: plugin process did not exit after termination"
                                .to_string(),
                        );
                    }
                    return Err(format!(
                        "PREINSTALL_TIMEOUT: plugin process exceeded {} seconds",
                        PLUGIN_PROCESS_TIMEOUT.as_secs()
                    ));
                }
                if wait == WAIT_FAILED || wait != WAIT_OBJECT_0 {
                    CloseHandle(handle.0);
                    return Err("PREINSTALL_WAIT: WaitForSingleObject failed".to_string());
                }
                let mut code: u32 = 0;
                if GetExitCodeProcess(handle.0, &mut code) == 0 {
                    CloseHandle(handle.0);
                    return Err("PREINSTALL_WAIT: GetExitCodeProcess failed".to_string());
                }
                CloseHandle(handle.0);
                Ok(code as i32)
            }
        })
        .await
        .map_err(|e| format!("PREINSTALL_WAIT: {e}"))??;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok((exit_code, output::drain_captured(captured)))
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new(node)
            .args(args)
            .env_clear()
            .envs(envs)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 独立进程组：取消时可用 `kill(-pid, ...)` 一次结束整棵安装进程树
            .process_group(0)
            .spawn()
            .map_err(|e| format!("PREINSTALL_SPAWN: {e}"))?;

        let pid = child.id();
        PidGuard::set(pid);
        // 绑定守卫实例：本 cfg 块作用域结束时自动把共享 PID 槽复位为 None，
        // 避免把「这一次安装」的 PID 泄漏给之后的取消/下一次安装（误杀无关进程）。
        // 若 spawn_blocking 因错误提前 `?` 返回，守卫同样会 Drop 复位。
        let _pid_guard = PidGuard;
        log::info!("dsh plugin install started, pid {pid}");

        if let Some(stdout) = child.stdout.take() {
            spawn_line_emitter(
                stdout,
                window.clone(),
                captured.clone(),
                log_limiter.clone(),
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_line_emitter(stderr, window.clone(), captured.clone(), log_limiter);
        }

        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            let deadline = Instant::now() + PLUGIN_PROCESS_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status.code().unwrap_or(1)),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Ok(None) => {
                        workflow::kill_pid_tree(pid);
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(format!(
                            "PREINSTALL_TIMEOUT: plugin process exceeded {} seconds",
                            PLUGIN_PROCESS_TIMEOUT.as_secs()
                        ));
                    }
                    Err(error) => break Err(format!("PREINSTALL_WAIT: {error}")),
                }
            }
        })
        .await
        .map_err(|e| format!("PREINSTALL_WAIT: {e}"))??;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok((exit_code, output::drain_captured(captured)))
    }
}

struct LogEventLimiter {
    window_started: Instant,
    emitted: usize,
}

impl LogEventLimiter {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            emitted: 0,
        }
    }

    fn allow(&mut self) -> bool {
        if self.window_started.elapsed() >= Duration::from_secs(1) {
            self.window_started = Instant::now();
            self.emitted = 0;
        }
        if self.emitted >= MAX_LOG_EVENTS_PER_SECOND {
            return false;
        }
        self.emitted += 1;
        true
    }
}

/// 在独立线程中逐行读取进程输出：实时通过 `preinstall-log` 事件转发，
/// 同时追加进有界尾部缓冲区。
fn spawn_line_emitter<R: std::io::Read + Send + 'static>(
    reader: R,
    window: WebviewWindow,
    captured: CapturedOutput,
    limiter: Arc<Mutex<LogEventLimiter>>,
) {
    output::spawn_bounded_reader(reader, captured, move |line| {
        let should_emit = limiter
            .lock()
            .map(|mut budget| budget.allow())
            .unwrap_or(false);
        if should_emit {
            let _ = window.emit(PREINSTALL_LOG_EVENT, PreinstallLogPayload { line });
        }
    });
}
