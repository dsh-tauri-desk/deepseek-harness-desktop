//! 应用全局配置、系统偏好与 CLI Link 集成。
//!
//! 桌面端自身设置（端口/自启/语言/主题/侧边栏）的读写，以及命令行集成的
//! 状态查询；命令行集成开关的落库顺序与 CLI Link 的文件/PATH 操作绑定。

use crate::config;
use crate::service::cli;
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZoomAction {
    Increase,
    Decrease,
    Reset,
}

/// 获取进程级缩放操作锁，防止并发快捷键交错读写而丢失缩放步进。
fn zoom_operation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 在同一锁内执行完整缩放事务，使 WebView 状态与持久化配置始终一致。
fn serialize_zoom_operation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = zoom_operation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation()
}

fn apply_zoom_factor(app_handle: &AppHandle, zoom_factor: f64) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "ZOOM_WINDOW_MISSING: Main window is not available".to_string())?;
    crate::desktop::zoom::apply_native_zoom(&window, zoom_factor)
}

fn next_zoom_factor(current: f64, action: ZoomAction) -> f64 {
    match action {
        ZoomAction::Increase => config::normalize_zoom_factor(current + config::ZOOM_FACTOR_STEP),
        ZoomAction::Decrease => config::normalize_zoom_factor(current - config::ZOOM_FACTOR_STEP),
        ZoomAction::Reset => config::default_zoom_factor(),
    }
}

fn persist_zoom_factor(app_handle: &AppHandle, zoom_factor: f64) -> Result<f64, String> {
    let zoom_factor = config::normalize_zoom_factor(zoom_factor);
    apply_zoom_factor(app_handle, zoom_factor)?;
    let setting = config::set_store_dat_zoom_factor(app_handle, zoom_factor);
    Ok(setting.zoom_factor)
}

/// 当前桌面端配置
#[tauri::command]
pub async fn get_app_config(app_handle: AppHandle) -> Result<config::Setting, String> {
    Ok(config::get_store_dat_setting(&app_handle))
}

/// 更新桌面端配置
#[tauri::command]
pub async fn update_app_config(
    app_handle: AppHandle,
    port: Option<u16>,
    auto_start: Option<bool>,
    cli_link_enabled: Option<bool>,
) -> Result<config::Setting, String> {
    if let Some(port) = port {
        if port == 0 {
            return Err("port must be a positive number".to_string());
        }
    }
    // 命令行集成：先执行文件系统/PATH 操作，成功后再持久化开关，
    // 失败时配置保持不变，避免"开关已开但 shim 未生成"的不一致状态。
    if let Some(enabled) = cli_link_enabled {
        if enabled {
            cli::ensure(&app_handle)?;
        } else {
            cli::remove(&app_handle)?;
        }
    }
    let setting = config::update_store_dat_setting(&app_handle, |setting| {
        if let Some(port) = port {
            setting.port = port;
            // 记住用户手动选择的端口：自动避让递增后仍能回落回用户值，而不是
            // 一路顶高（issue #91，见 workflow::launch 的端口自愈逻辑）
            setting.manual_port = Some(port);
        }
        if let Some(auto_start) = auto_start {
            setting.auto_start = auto_start;
        }
        if let Some(enabled) = cli_link_enabled {
            setting.cli_link_enabled = enabled;
        }
    });
    Ok(setting)
}

/// 把设置面板选择的缩放比例立即应用到主 WebView 并持久化。
#[tauri::command]
pub fn set_webview_zoom(app_handle: AppHandle, zoom_factor: f64) -> Result<f64, String> {
    serialize_zoom_operation(|| persist_zoom_factor(&app_handle, zoom_factor))
}

/// 调整主 WebView 缩放并立即持久化，供宿主和内嵌页面的快捷键共用。
#[tauri::command]
pub fn adjust_webview_zoom(app_handle: AppHandle, action: ZoomAction) -> Result<f64, String> {
    serialize_zoom_operation(|| {
        let setting = config::get_store_dat_setting(&app_handle);
        let zoom_factor = next_zoom_factor(setting.zoom_factor, action);
        persist_zoom_factor(&app_handle, zoom_factor)
    })
}

/// 命令行集成状态（shim 文件与 PATH 注册情况）
#[tauri::command]
pub fn get_cli_link_status(app_handle: AppHandle) -> Result<cli::CliLinkStatus, String> {
    Ok(cli::get_status(&app_handle))
}

/// 保存界面语言偏好
#[tauri::command]
pub fn set_language(app_handle: AppHandle, lang: String) {
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.language = lang.clone();
    config::set_store_dat_setting(&app_handle, setting);
    config::i18n::set_language(match lang.as_str() {
        "en" | "en-US" => config::i18n::Lang::En,
        _ => config::i18n::Lang::Zh,
    });
    #[cfg(target_os = "macos")]
    if let Err(error) = crate::desktop::builder::install_macos_menu(&app_handle) {
        log::warn!("[menu] failed to refresh macOS menu language: {error}");
    }
}

/// 切换侧边栏（布局状态保存在前端，保留该命令以对齐参考实现）
#[tauri::command]
pub async fn toggle_sidebar() -> Result<bool, String> {
    Ok(true)
}

/// 当前 dsh 主题偏好（light/dark/system），用于让桌面外壳跟随内嵌页面主题
#[tauri::command]
pub fn get_dsh_theme(app_handle: AppHandle) -> config::DshTheme {
    config::get_dsh_theme(&app_handle)
}

#[cfg(test)]
mod tests {
    use super::{next_zoom_factor, ZoomAction};
    use crate::config::{ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN};

    #[test]
    fn zoom_actions_step_reset_and_clamp() {
        assert!((next_zoom_factor(1.0, ZoomAction::Increase) - 1.1).abs() < f64::EPSILON);
        assert!((next_zoom_factor(1.0, ZoomAction::Decrease) - 0.9).abs() < f64::EPSILON);
        assert_eq!(next_zoom_factor(1.7, ZoomAction::Reset), 1.0);
        assert_eq!(
            next_zoom_factor(ZOOM_FACTOR_MAX, ZoomAction::Increase),
            ZOOM_FACTOR_MAX
        );
        assert_eq!(
            next_zoom_factor(ZOOM_FACTOR_MIN, ZoomAction::Decrease),
            ZOOM_FACTOR_MIN
        );
    }
}
