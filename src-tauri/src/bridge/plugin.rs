//! 预装与已安装插件的增删改查、管理。
//!
//! 包括首次启动的预装插件引导（安装/取消/跳过/待办检测/打开仓库）、已安装
//! 插件的列表/升级/卸载，以及运行期异常的记录与「卸除此插件并继续检测」修复。

use crate::config;
use crate::service::plugin;
use tauri::AppHandle;
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

/// 获取预装插件列表（含已安装检测结果），首次启动引导界面渲染用
#[tauri::command]
pub async fn get_preinstall_plugins(
    app_handle: AppHandle,
) -> Result<Vec<plugin::PreinstallPlugin>, String> {
    Ok(plugin::list(&app_handle))
}

/// 安装选中的预装插件（`dsh plugin --profile web add <ids...>`），
/// 进程输出实时通过 `preinstall-log` 事件推送；成功后标记引导完成并记录预设指纹。
#[tauri::command]
pub async fn install_preinstall_plugins(
    app_handle: AppHandle,
    ids: Vec<String>,
) -> Result<(), String> {
    plugin::install(&app_handle, &ids).await?;
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.preinstall_done = true;
    if let Some(hash) = plugin::current_preset_hash(&app_handle) {
        setting.preset_hash = Some(hash);
    }
    config::set_store_dat_setting(&app_handle, setting);
    Ok(())
}

/// 取消正在进行的预装插件安装（网络抖动/限流卡住时用户点“取消”）。
#[tauri::command]
pub async fn cancel_preinstall_plugins(app_handle: AppHandle) {
    plugin::cancel(&app_handle).await;
}

/// 跳过预装插件引导：记录状态与预设指纹，之后不再弹出（除非清单内容变更）
#[tauri::command]
pub async fn skip_preinstall_plugins(app_handle: AppHandle) -> Result<(), String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.preinstall_done = true;
    if let Some(hash) = plugin::current_preset_hash(&app_handle) {
        setting.preset_hash = Some(hash);
    }
    config::set_store_dat_setting(&app_handle, setting);
    Ok(())
}

/// 内置插件启动自愈（供前端 boot 流程调用，独立于预装引导「继续/跳过」）。
///
/// 与 service 启动路径（`workflow::launch` 内）共用 `plugin::ensure_internal_plugins`
/// 同一实现：内部有并发锁、幂等，此后启动/重启路径会再核对但均为 no-op。
/// 最佳努力：失败只记告警，不阻断启动；前端据此在「Loading internal plugins…」
/// 与「Loading plugins…」之间切换加载屏文案。
#[tauri::command]
pub async fn ensure_internal_plugins(app_handle: AppHandle) {
    if let Err(e) = plugin::ensure_internal_plugins(&app_handle).await {
        log::warn!("ensure internal plugins via bridge failed: {e}");
    }
}

/// 是否有新的预装插件需要引导：预设清单内容与上次记录不一致（或老用户无基线）。
/// 资源文件每次安装都被强制覆盖不可比对，只能比对 app-data 里记录的内容指纹。
#[tauri::command]
pub fn get_preinstall_pending(app_handle: AppHandle) -> Result<bool, String> {
    Ok(plugin::preinstall_pending(&app_handle))
}

/// 在系统浏览器中打开预装插件的仓库地址（仅允许预装清单内的 id）
#[tauri::command]
pub async fn open_preinstall_repo(app_handle: AppHandle, id: String) -> Result<(), String> {
    let url = plugin::repo_url_of(&app_handle, &id)
        .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 当前 profile 已安装插件列表（含解析后的元信息），`use-dsh-plugins` 首次加载用；
/// 之后 Rust 侧监控插件文件，变化时通过 `dsh-plugins-updated` 事件实时推送。
/// 这里会并入 `updates` 模块的已知更新判定缓存（未判定时 `update_available=false`）。
#[tauri::command]
pub fn get_dsh_plugins(app_handle: AppHandle) -> Vec<plugin::DshPlugin> {
    let mut plugins = plugin::watch::list(&app_handle);
    plugin::update::apply_cache(&app_handle, &mut plugins);
    plugins
}

/// 重新探测已安装插件的更新可用性（网络 + 30min 缓存），返回带最新判定结果的列表。
///
/// 与 `get_dsh_plugins` 不同，此处会发起 registry / GitHub 请求（并行、失败静默按
/// 「无更新」处理）。前端在插件面板挂载后调用一次以补齐 `updateAvailable`，使升级
/// 按钮只在确有更新（或异常修复）时出现，而不是常驻。
#[tauri::command]
pub async fn refresh_plugin_updates(
    app_handle: AppHandle,
) -> Result<Vec<plugin::DshPlugin>, String> {
    plugin::update::refresh(&app_handle).await
}

/// 升级单个已安装插件：`dsh plugin --profile <当前档案> update <id>`，
/// 进程输出通过 `preinstall-log` 事件实时推送。
#[tauri::command]
pub async fn update_dsh_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::update(&app_handle, &id).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 卸载单个已安装插件：`dsh plugin --profile <当前档案> remove <id>`，
/// 进程输出通过 `preinstall-log` 事件实时推送。
#[tauri::command]
pub async fn remove_dsh_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::remove(&app_handle, &id).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 上报插件运行期异常（内嵌页面 / dsh-tauri 桥调用），记录后立即推送新列表，
/// 并推送 `plugin-recovery-required` 让前端弹出「卸除此插件并继续检测」修复界面。
#[tauri::command]
pub fn report_plugin_error(
    app_handle: AppHandle,
    id: String,
    error: String,
    action: Option<String>,
) -> Result<(), String> {
    let requested_action = action.as_deref().unwrap_or("runtime");
    let (action, message) = plugin::errors::validate_input(&id, requested_action, &error)?;
    if !plugin::is_installed(&app_handle, &id) {
        return Err("PLUGIN_ERROR_UNKNOWN_PLUGIN: plugin is not installed".to_string());
    }
    plugin::errors::record(&app_handle, &id, &action, &message)?;
    plugin::watch::force_emit(&app_handle);
    // 运行期异常：直接推送修复界面（应用仍在运行，前端以醒目对话框呈现）。
    let info = plugin::PluginRecoveryInfo {
        plugins: vec![id],
        reason: "runtime".to_string(),
        detail: String::new(),
        raw_error: message,
    };
    let _ = app_handle.emit(plugin::recovery::RECOVERY_REQUIRED_EVENT, &info);
    Ok(())
}

/// 从启动日志定位导致启动失败的问题插件（含归属到配置根插件）。
///
/// 前端在启动失败时已读过服务日志（`read_service_logs`），这里直接传入日志行，
/// 由 Rust 侧按错误特征提取引用并做证据式归属；未定位到具体插件时 `plugins` 为空。
#[tauri::command]
pub fn detect_plugin_recovery(
    app_handle: AppHandle,
    logs: Vec<String>,
) -> plugin::PluginRecoveryInfo {
    plugin::detect_recovery(&app_handle, &logs)
}

/// 修复模式卸载单个插件：直接改 profile 清单（离线、精准），成功后推送新插件列表。
///
/// 与 `remove_dsh_plugin`（走 `dsh plugin remove`）不同，此命令不依赖网络，专用于
/// 「插件异常修复」场景；前端随后 `restart()` 重启并重新检测。
#[tauri::command]
pub fn recover_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::uninstall_recovery(&app_handle, &id)?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}
