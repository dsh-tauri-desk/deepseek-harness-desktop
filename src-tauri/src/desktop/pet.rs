//! 桌宠独立窗口。
//!
//! 桌宠是 Tauri 多 WebView 方案下的第二个窗口（`label: "pet"`）：独立透明、
//! 置顶、无边框、不进任务栏（跨平台 BongoCat 已验证同款组合，见 issue #308）。
//! 本模块负责：
//! - 窗口创建（透明 + 置顶 + 无装饰 + skipTaskbar + 无阴影）；
//! - 几何保存 / 恢复（复用 `config::window_state` 的几何恢复逻辑，但用独立 store 键）；
//! - 启停（读取 `setting.pet_enabled`，侧边栏/设置页通过 bridge 命令调用）。
//!
//! 状态传递走文件桥（`config::pet_state`）：主窗体把 dsh 会话事件归一化后写成
//! `$DSH_HOME/pets/state.json`，宠物窗口前端以 `fs-watcher + 轮询` 读取并切换动画。

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};

use crate::config;

/// 桌宠窗口 label。
pub const PET_WINDOW_LABEL: &str = "pet";
/// 桌宠窗口逻辑宽度。
pub const PET_WINDOW_WIDTH: f64 = 240.0;
/// 桌宠窗口逻辑高度。
pub const PET_WINDOW_HEIGHT: f64 = 280.0;
/// store 中记录桌宠窗口几何的键（与主窗口 `window_state` 区分开）。
const STORE_PET_WINDOW_STATE_KEY: &str = "pet_window_state";

/// 当前桌宠是否启用（取设置中的开关）。
pub fn is_pet_enabled<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    config::get_store_dat_setting(app_handle).pet_enabled
}

/// 当前选中的桌宠 id。
pub fn active_pet_id<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    config::get_store_dat_setting(app_handle).active_pet_id
}

/// 桌宠是否已创建且可见。
pub fn is_pet_visible<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    app_handle
        .get_webview_window(PET_WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 创建桌宠窗口（若尚未创建）。
///
/// 独立透明置顶小窗（透明 + always_on_top + 无边框 + skipTaskbar + 无阴影）。
/// 幂等：窗口已存在时直接返回现有窗口，避免重复创建。
pub fn ensure_pet_window(app_handle: &AppHandle<Wry>) -> tauri::Result<WebviewWindow<Wry>> {
    if let Some(existing) = app_handle.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(existing);
    }

    let builder = WebviewWindowBuilder::new(app_handle, PET_WINDOW_LABEL, WebviewUrl::App("pet.html".into()))
        .title("Deepseek Harness Pet")
        .inner_size(PET_WINDOW_WIDTH, PET_WINDOW_HEIGHT)
        // 无边框、置顶、不进任务栏、去除阴影：桌宠小窗语义。
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        // 透明背景，宠物动画与桌面融合（平台不支持时退化为不透明，功能不受影响）。
        .transparent(true);

    let window = builder.build()?;
    config::restore_window_state(app_handle, &window, STORE_PET_WINDOW_STATE_KEY);

    log::info!(
        "[pet] window created ({}x{PET_WINDOW_HEIGHT})",
        PET_WINDOW_WIDTH
    );
    Ok(window)
}

/// 隐藏桌宠窗口（保留窗口对象与状态，隐藏而非销毁避免重建闪烁）。
pub fn hide_pet_window<R: Runtime>(app_handle: &AppHandle<R>) {
    if let Some(window) = app_handle.get_webview_window(PET_WINDOW_LABEL) {
        let _ = window.hide();
        log::info!("[pet] window hidden");
    }
}

/// 显示桌宠窗口（若已启用）。未启用时静默 no-op（不自动创建）。
pub fn show_pet_window(app_handle: &AppHandle<Wry>) {
    if !is_pet_enabled(app_handle) {
        log::debug!("[pet] disabled, skip show");
        return;
    }
    match ensure_pet_window(app_handle) {
        Ok(window) => {
            let _ = window.unminimize();
            let _ = window.show();
        }
        Err(e) => log::warn!("[pet] failed to ensure window: {e}"),
    }
}

/// 把桌宠窗口的几何保存到独立 store 键（移动/缩放/退出时调用）。
pub fn save_pet_geometry<R: Runtime>(window: &tauri::Window<R>) {
    config::save_geometry_under(window, STORE_PET_WINDOW_STATE_KEY);
}

/// 按启用状态同步桌宠窗口的出现/隐藏。应用启动与开关切换后调用。
pub fn sync_pet_window(app_handle: &AppHandle<Wry>) {
    if is_pet_enabled(app_handle) {
        show_pet_window(app_handle);
    }
    else {
        hide_pet_window(app_handle);
    }
}