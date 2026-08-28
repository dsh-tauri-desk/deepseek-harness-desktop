#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::Arc;

#[cfg(windows)]
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{
    webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse},
    Emitter, Runtime, Url, Webview,
};
#[cfg(windows)]
use tauri::{WebviewWindow, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::desktop::payload::DownloadFinishedPayload;

/// 接管内嵌 iframe 的 `window.open()` / `target=_blank` 新窗口请求：
/// WebView2 里这类请求走 NewWindowRequested，wry 在没有 handler 时直接吞掉。
/// 这里把 http(s) 链接交给系统浏览器打开，其余协议一律拒绝。
pub fn on_new_window<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    url: Url,
    _features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    if matches!(url.scheme(), "http" | "https") {
        if let Err(e) = app_handle.opener().open_url(url.to_string(), None::<&str>) {
            log::warn!("[new-window] open in browser failed {e}");
        }
    } else {
        log::debug!("[new-window] denied {url}");
    }
    NewWindowResponse::Deny
}

/// 接管下载：保存到系统下载目录，重名时自动加 " (n)" 后缀，
/// 完成后向前端 emit `harness-download-finished`。
pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            *destination = config::unique_download_path(destination);
            log::info!("[download] requested {} -> {}", url, destination.display());
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let path_str = path.as_ref().map(|p| p.to_string_lossy().to_string());
            let payload = DownloadFinishedPayload {
                url: url.to_string(),
                path: path_str,
                success,
            };
            let _ = webview.emit("harness-download-finished", payload);
            log::info!(
                "[download] finished {} success={} path={:?}",
                url,
                success,
                path
            );
            true
        }
        // DownloadEvent 为 #[non_exhaustive]，预留未来变体
        _ => true,
    }
}

#[cfg(windows)]
pub fn on_page_load(
    webview_window: WebviewWindow<Wry>,
    payload: PageLoadPayload<'_>,
    notification_handlers_registered_for_page: Arc<AtomicBool>,
) {
    // Windows 依赖 WebView2 的 FramePermissionRequested / FrameCreated 机制，
    // 需要在页面加载时注册；非 Windows 已在 build_main_window 里通过
    // initialization_script_for_all_frames 注入，这里不需要再做处理。
    if payload.event() == PageLoadEvent::Started
        && !notification_handlers_registered_for_page
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        log::info!("[notification] top-level page load started; scheduling handler registration");
        let parent = webview_window.clone();
        if let Err(e) = webview_window.with_webview(move |platform| {
            if let Err(e) =
                crate::desktop::notification::enable_notification_permissions(platform, parent)
            {
                log::warn!("[webview] failed to enable notification permission: {e}");
            }
        }) {
            log::warn!("[webview] failed to schedule notification permission setup: {e}");
        }
    }
}
