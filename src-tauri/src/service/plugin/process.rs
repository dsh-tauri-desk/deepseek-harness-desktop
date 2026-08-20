//! dsh 子进程执行：启动 `dsh plugin` 进程并等待退出，输出逐行转发为事件。
//!
//! Windows 打包版是 GUI 进程（无控制台），直接以 CREATE_NO_WINDOW 启动会让
//! dsh 派生的子进程各建可见控制台窗口（黑窗闪烁），因此复用
//! `service/workflow/win_spawn` 的隐藏控制台方案并额外跟踪进程句柄以等待退出；
//! Unix 上直接以管道捕获标准输出/错误。

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use tauri::{Emitter, WebviewWindow};

#[cfg(windows)]
use crate::service::workflow;
#[cfg(not(windows))]
use std::process::{Command, Stdio};

/// 前端监听的插件命令控制台事件名（dsh plugin 进程与桌面端编排输出）
pub(crate) const PLUGIN_COMMAND_LOG_EVENT: &str = "dsh-plugin-command-log";

/// 插件命令控制台输出载荷
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandLogPayload {
    pub line: String,
}

/// 向前端转发一行插件命令控制台输出。
pub(crate) fn emit_plugin_log(window: &WebviewWindow, line: impl Into<String>) {
    let _ = window.emit(
        PLUGIN_COMMAND_LOG_EVENT,
        PluginCommandLogPayload { line: line.into() },
    );
}

/// Windows 进程句柄包装：原始句柄是 `*mut c_void`（非 Send），
/// 但 `WaitForSingleObject`/`GetExitCodeProcess` 均为线程安全的系统调用，
/// 包一层以安全地移入 `spawn_blocking` 等待进程退出。
#[cfg(windows)]
struct WaitableHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for WaitableHandle {}

/// 启动 `dsh plugin` 进程并等待结束，返回退出码；输出实时转发事件。
pub(crate) async fn run_plugin_process(
    node: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &HashMap<String, String>,
    window: &WebviewWindow,
) -> Result<i32, String> {
    #[cfg(windows)]
    {
        let (stdout, stderr, handle) =
            workflow::win_spawn::spawn_with_hidden_console_tracked(node, args, Some(cwd), envs)
                .map_err(|e| format!("PLUGIN_COMMAND_SPAWN: {e}"))?;

        spawn_line_emitter(stdout, window.clone());
        spawn_line_emitter(stderr, window.clone());

        let handle = WaitableHandle(handle);
        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, WaitForSingleObject, INFINITE,
            };
            let handle = handle;
            unsafe {
                let wait = WaitForSingleObject(handle.0, INFINITE);
                let mut code: u32 = 0;
                if GetExitCodeProcess(handle.0, &mut code) == 0 {
                    code = wait;
                }
                CloseHandle(handle.0);
                code as i32
            }
        })
        .await
        .map_err(|e| format!("PLUGIN_COMMAND_WAIT: {e}"))?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok(exit_code)
    }

    #[cfg(not(windows))]
    {
        let mut child = Command::new(node)
            .args(args)
            .envs(envs)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("PLUGIN_COMMAND_SPAWN: {e}"))?;

        if let Some(stdout) = child.stdout.take() {
            spawn_line_emitter(stdout, window.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_line_emitter(stderr, window.clone());
        }

        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1)
        })
        .await
        .map_err(|e| format!("PLUGIN_COMMAND_WAIT: {e}"))?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok(exit_code)
    }
}

/// 在独立线程中逐行读取进程输出并通过插件命令事件转发。
/// 使用静态泛型约束 `R: Read + Send + 'static` 避免动态派发（Box<dyn Read>）堆分配。
fn spawn_line_emitter<R: Read + Send + 'static>(reader: R, window: WebviewWindow) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines().map_while(Result::ok) {
            emit_plugin_log(&window, line.trim_end().to_string());
        }
    });
}