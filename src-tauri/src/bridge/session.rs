//! 会话文件管理命令

use crate::service::session;
use tauri::AppHandle;

/// 获取全部会话文件信息
#[tauri::command]
pub async fn get_session_files(app_handle: AppHandle) -> Result<Vec<session::SessionFileInfo>, String> {
    // 45MB 大文件解析放在阻塞线程，避免卡住 async 运行时
    tokio::task::spawn_blocking(move || session::list(&app_handle))
        .await
        .map_err(|e| format!("SESSION_SCAN_FAILED: join failed: {e}"))?
}

/// 分页获取会话（过滤+排序下沉 Rust）
#[tauri::command]
pub async fn get_session_files_paged(
    app_handle: AppHandle,
    filter: Option<String>,
    search: Option<String>,
    sort_key: Option<String>,
    sort_asc: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<session::PagedSessionResult, String> {
    let filter = filter;
    let search = search;
    let sort_key = sort_key;
    let sort_asc = sort_asc.unwrap_or(false);
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(50);
    let limit = limit.clamp(1, 2000);
    tokio::task::spawn_blocking(move || session::list_paged(&app_handle, filter, search, sort_key, sort_asc, offset, limit))
        .await
        .map_err(|e| format!("SESSION_SCAN_FAILED: join failed: {e}"))?
}

/// 彻底删除会话（文件系统 + 索引）
#[tauri::command]
pub async fn delete_session_files(app_handle: AppHandle, ids: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || session::delete(&app_handle, ids))
        .await
        .map_err(|e| format!("SESSION_DELETE_FAILED: join failed: {e}"))?
}

/// 恢复归档会话（从 archived 移回 active）
#[tauri::command]
pub async fn restore_session_files(app_handle: AppHandle, ids: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || session::restore(&app_handle, ids))
        .await
        .map_err(|e| format!("SESSION_RESTORE_FAILED: join failed: {e}"))?
}

/// 在文件管理器中打开会话所在目录
#[tauri::command]
pub async fn open_session_dir(app_handle: AppHandle, id: String) -> Result<(), String> {
    let path = tokio::task::spawn_blocking(move || session::reveal_path(&app_handle, id))
        .await
        .map_err(|e| format!("SESSION_REVEAL_FAILED: join failed: {e}"))??;
    // 使用 opener 打开目录（与 bridge::system_os::open_dir 一致）
    tauri_plugin_opener::open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("SESSION_REVEAL_FAILED: open failed: {e}"))
}
