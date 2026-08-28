//! 取消正在进行的预装插件安装。
//!
//! 跨平台结束由本应用拉起的 `dsh plugin` 安装进程树：
//! - Unix（macOS/Linux）：进程以独立进程组启动（`process_group(0)`，见
//!   `process.rs`），此处对注册的 PID 强制结束整组（含 pnpm / git 等子进程）；
//! - Windows：对创建时记录的精确 PID 执行 `taskkill /T /F`，不再按命令行模糊
//!   枚举，避免误杀其它插件操作或用户进程。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 前端监听“安装已取消”事件名
const PREINSTALL_CANCEL_EVENT: &str = "preinstall-cancelled";

/// 取消事件载荷（预留扩展字段）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallCancelPayload {}

/// 强制结束当前插件安装进程树。返回是否找到并成功结束了活动进程。
pub(crate) async fn terminate_active_install() -> bool {
    let active = super::process::active_plugin_processes();
    if active.is_empty() {
        log::debug!("plugin install cancel: no active install process");
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut all_terminated = true;
        for (_, pid) in active {
            all_terminated &= terminate_pid_tree(pid);
        }
        all_terminated
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("plugin install cancel task failed: {e}");
        false
    })
}

pub(crate) async fn terminate_owned_install(owner: super::process::ProcessOwner) -> bool {
    let Some(pid) = super::process::active_plugin_pid(owner) else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || terminate_pid_tree(pid))
        .await
        .unwrap_or_else(|e| {
            log::warn!("owned plugin install cancel task failed: {e}");
            false
        })
}

#[cfg(windows)]
fn terminate_pid_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000);
    let ok = command
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    log::warn!("plugin install cancel: taskkill pid {pid} success={ok}");
    ok
}

#[cfg(not(windows))]
fn terminate_pid_tree(pid: u32) -> bool {
    // `--` 防止负 PID 被解析为信号；KILL 保证忽略 TERM 的 pnpm/git 后代也退出。
    let group = std::process::Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    let direct = group
        || std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    log::warn!("plugin install cancel: kill process group {pid} success={direct}");
    direct
}

/// 取消正在进行的预装插件安装。
pub async fn cancel(app_handle: &AppHandle) {
    terminate_active_install().await;

    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit(PREINSTALL_CANCEL_EVENT, PreinstallCancelPayload {});
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn spawn_hung_child() -> std::process::Child {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd.exe");
        command
            .args(["/C", "ping -n 60 127.0.0.1 >NUL"])
            .creation_flags(0x08000000);
        command.spawn().unwrap()
    }

    #[cfg(unix)]
    fn spawn_hung_child() -> std::process::Child {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 60"]).process_group(0);
        command.spawn().unwrap()
    }

    #[tokio::test]
    async fn forced_cancel_kills_hung_child_and_releases_pid_slot() {
        let mut child = spawn_hung_child();
        let pid = child.id();
        let owner = super::super::process::new_process_owner();
        let guard = super::super::process::PidGuard::set(owner, pid);

        assert_eq!(super::super::process::active_plugin_pid(owner), Some(pid));
        assert!(terminate_owned_install(owner).await);

        let exited = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await;
        assert!(exited.is_ok(), "hung plugin child should be force-killed");

        drop(guard);
        assert_eq!(super::super::process::active_plugin_pid(owner), None);
    }
}
