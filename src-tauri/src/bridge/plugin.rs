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
///
/// 同时支持卸载用户取消勾选的已安装插件（`uninstall_ids`）：走
/// `dsh plugin remove`（与安装对称的命令行卸载），失败时自动回退离线精准卸载
/// （`plugin::uninstall_recovery`，直接改 profile 清单），不依赖网络兜底。
#[tauri::command]
pub async fn install_preinstall_plugins(
    app_handle: AppHandle,
    install_ids: Vec<String>,
    uninstall_ids: Vec<String>,
) -> Result<(), String> {
    // 安装与卸载均为空：无需操作，直接标记完成
    if install_ids.is_empty() && uninstall_ids.is_empty() {
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.preinstall_done = true;
        if let Some(hash) = plugin::current_preset_hash(&app_handle) {
            setting.preset_hash = Some(hash);
        }
        config::set_store_dat_setting(&app_handle, setting);
        return Ok(());
    }

    // 先卸载取消勾选的已安装插件（走 dsh plugin remove，与安装对称）
    // 卸载在前：避免新装插件与待卸载插件冲突；remove 内部会先停服务再执行
    log::info!("[preinstall] uninstall_ids={uninstall_ids:?}, install_ids={install_ids:?}");
    for id in &uninstall_ids {
        log::info!("[preinstall] removing plugin {id} via dsh plugin remove");
        if let Err(e) = plugin::remove(&app_handle, id).await {
            log::error!("[preinstall] failed to remove plugin {id}: {e}");
            return Err(e);
        }
        log::info!("[preinstall] successfully removed plugin {id}");
    }

    // 再安装新勾选的插件（会走 dsh plugin add）
    if !install_ids.is_empty() {
        log::info!("[preinstall] installing plugins {install_ids:?}");
        plugin::install(&app_handle, &install_ids).await?;
    }

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
/// 错误返回前端，由启动状态机按 plugin-install 阶段展示精确错误与重试入口；
/// workflow 自启动路径仍保留最佳努力语义。
#[tauri::command]
pub async fn ensure_internal_plugins(app_handle: AppHandle) -> Result<(), String> {
    plugin::ensure_internal_plugins(&app_handle).await
}

/// 取消共享的内置插件自愈并等待子进程树退出，供启动阶段超时后清理。
#[tauri::command]
pub async fn cancel_internal_plugins() -> Result<(), String> {
    plugin::cancel_internal_plugins().await
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
    plugin::errors::record(
        &app_handle,
        &id,
        action.as_deref().unwrap_or("runtime"),
        &error,
    )?;
    plugin::watch::force_emit(&app_handle);
    // 运行期异常：直接推送修复界面（应用仍在运行，前端以醒目对话框呈现）。
    let info = plugin::PluginRecoveryInfo {
        plugins: vec![id],
        reason: "runtime".to_string(),
        detail: String::new(),
        raw_error: error,
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

/// 禁用单个已安装插件：从 profile 的 `dsh.profile.bundles` 移除（代码完全不加载），
/// 并写入 profile 的独立禁用清单。与卸载不同，禁用保留 node_modules 内的包体，
/// 启用时无需重新下载。
#[tauri::command]
pub fn disable_dsh_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::disable(&app_handle, &id)?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 启用单个已禁用的插件：加回 `dsh.profile.bundles` 并从独立禁用清单移除。
#[tauri::command]
pub fn enable_dsh_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::enable(&app_handle, &id)?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 创建单个插件的快照（覆盖式：已存在则整体替换），存档于
/// `$DSH_HOME/.plugin-backups/<id>.tgz`。
#[tauri::command]
pub fn snapshot_plugin(app_handle: AppHandle, id: String) -> Result<plugin::snapshot::SnapshotInfo, String> {
    plugin::snapshot::create(&app_handle, &id)
}

/// 批量创建插件快照（升级前置自动快照）：单项失败只记录在结果里，不阻断其它项。
#[tauri::command]
pub fn snapshot_plugins(
    app_handle: AppHandle,
    ids: Vec<String>,
) -> Result<Vec<plugin::snapshot::SnapshotResult>, String> {
    Ok(plugin::snapshot::create_many(&app_handle, &ids))
}

/// 查询单个插件的快照信息（存在性 + 时间 + 大小 + 是否含配置段）。
#[tauri::command]
pub fn get_plugin_backup(
    app_handle: AppHandle,
    id: String,
) -> plugin::snapshot::PluginBackupInfo {
    plugin::snapshot::get(&app_handle, &id)
}

/// 还原单个插件的快照（覆盖式，内部停服务；仅第三方可行动插件允许）。
#[tauri::command]
pub async fn restore_plugin(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::snapshot::restore(&app_handle, &id).await?;
    plugin::watch::force_emit(&app_handle);
    Ok(())
}

/// 删除单个插件的快照（卸载级联清理 / 手动删除）：幂等，无快照视为成功。
#[tauri::command]
pub fn delete_plugin_backup(app_handle: AppHandle, id: String) -> Result<(), String> {
    plugin::snapshot::delete(&app_handle, &id)
}
