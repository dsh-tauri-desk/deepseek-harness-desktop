use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Emitter;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub enum Status {
    Initial,
    Installing,
    Starting,
    Running,
    Stopped,
}

// 使用静态变量在模块内部管理状态
static DSH_STATUS: OnceLock<Mutex<Status>> = OnceLock::new();

pub fn get_status_lock() -> &'static Mutex<Status> {
    DSH_STATUS.get_or_init(|| Mutex::new(Status::Initial))
}

pub fn set_status(status: Status) {
    // 中毒安全：忽略此前 panic 造成的锁中毒，避免连锁 panic 导致进程退出
    *get_status_lock().lock().unwrap_or_else(|e| e.into_inner()) = status;
}

pub fn emit_status(app_handle: &AppHandle) {
    let status = get_status();
    let _ = app_handle.emit("dsh-status-updated", &status);
}

pub fn get_status() -> Status {
    get_status_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
