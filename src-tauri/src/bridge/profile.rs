//! 多 Profile 环境隔离。
//!
//! 管理 `$DSH_HOME/profiles` 下的档案：列表、创建（web 模板）、切换当前使用中的
//! 档案，以及删除（默认档案与使用中的档案不可删除）。

use crate::service::profile;
use tauri::AppHandle;

/// 档案列表（$DSH_HOME/profiles 下的目录，含 active/default 标记）
#[tauri::command]
pub fn get_profiles(app_handle: AppHandle) -> Vec<profile::Profile> {
    profile::list(&app_handle)
}

/// 新建档案（初始化 $DSH_HOME/profiles/<id>，web 模板）
#[tauri::command]
pub fn create_profile(app_handle: AppHandle, name: String) -> Result<profile::Profile, String> {
    profile::create(&app_handle, &name)
}

/// 切换当前使用中的档案（持久化；重启服务后生效，由前端触发）
#[tauri::command]
pub fn set_active_profile(app_handle: AppHandle, id: String) -> Result<profile::Profile, String> {
    profile::set_active(&app_handle, &id)
}

/// 删除档案（默认档案与使用中的档案不可删除）
#[tauri::command]
pub fn remove_profile(app_handle: AppHandle, id: String) -> Result<(), String> {
    profile::remove(&app_handle, &id)
}
