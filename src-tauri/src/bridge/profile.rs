//! 多 Profile 环境隔离。
//!
//! 管理 `$DSH_HOME/profiles` 下的档案：列表、创建（web 模板）、克隆、切换当前
//! 使用中的档案、删除（默认档案与使用中的档案不可删除），以及档案的 ZIP 备份
//! （列出 / 创建 / 还原 / 自动备份设置，见 `service::profile::backup`）。

use crate::config;
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

/// 克隆档案（`web` → `web-1`、`web-2`；复制配置、排除依赖目录，写入依赖重建标记）。
/// `name` 为 `Some` 时按自定义名称克隆（规范化后作为新档案 id）。
#[tauri::command]
pub fn clone_profile(
    app_handle: AppHandle,
    id: String,
    name: Option<String>,
) -> Result<profile::Profile, String> {
    profile::clone(&app_handle, &id, name.as_deref())
}

/// 重命名档案（含描述更新；只改 manifest 展示元信息，目录 id 不变）
#[tauri::command]
pub fn rename_profile(
    app_handle: AppHandle,
    id: String,
    name: String,
    description: String,
) -> Result<profile::Profile, String> {
    profile::update_meta(&app_handle, &id, &name, &description)
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

/// 列出档案备份（最新在前）
#[tauri::command]
pub fn get_profile_backups(
    app_handle: AppHandle,
    profile_id: String,
) -> Result<Vec<profile::ProfileBackup>, String> {
    profile::backup::list(&app_handle, &profile_id)
}

/// 手动创建档案备份
#[tauri::command]
pub fn create_profile_backup(
    app_handle: AppHandle,
    profile_id: String,
) -> Result<profile::ProfileBackup, String> {
    profile::backup::create(&app_handle, &profile_id)
}

/// 还原档案备份（当前运行档案先停止 Harness，`serviceStopped` 时前端走既有重启流程）
#[tauri::command]
pub async fn restore_profile_backup(
    app_handle: AppHandle,
    profile_id: String,
    backup_id: String,
) -> Result<profile::RestoreResult, String> {
    profile::backup::restore(&app_handle, &profile_id, &backup_id).await
}

/// 删除一份档案备份
#[tauri::command]
pub fn delete_profile_backup(
    app_handle: AppHandle,
    profile_id: String,
    backup_id: String,
) -> Result<(), String> {
    profile::backup::delete(&app_handle, &profile_id, &backup_id)
}

/// 读取档案自动备份设置
#[tauri::command]
pub fn get_profile_backup_settings(app_handle: AppHandle) -> config::ProfileBackupSettings {
    profile::backup::get_settings(&app_handle)
}

/// 保存档案自动备份设置
#[tauri::command]
pub fn update_profile_backup_settings(
    app_handle: AppHandle,
    settings: config::ProfileBackupSettings,
) -> Result<config::ProfileBackupSettings, String> {
    profile::backup::update_settings(&app_handle, settings)
}
