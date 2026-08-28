//! 内嵌 Harness 页面缩放快捷键桥。
//!
//! 键盘事件不会从跨源 iframe 冒泡到桌面壳层，因此在直接子 frame 中捕获
//! Ctrl/Cmd + `+`/`-`/`0`，再把经过收窄的动作交给宿主。宿主仍会校验消息来源。

#[cfg(target_os = "macos")]
use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
use tauri::{Runtime, WebviewWindow};

#[cfg(any(target_os = "macos", test))]
const MINIMUM_MACOS_ZOOM_MAJOR: isize = 11;

#[cfg(any(target_os = "macos", test))]
fn macos_zoom_support_error(
    is_at_least_macos_11: bool,
    major: isize,
    minor: isize,
) -> Option<String> {
    if is_at_least_macos_11 {
        return None;
    }
    Some(format!(
        "ZOOM_UNSUPPORTED_OS: macOS {major}.{minor} does not support native WebView zoom; macOS 11 or newer is required"
    ))
}

#[cfg(target_os = "macos")]
fn current_platform_zoom_support_error() -> Option<String> {
    let process_info = NSProcessInfo::processInfo();
    let minimum = NSOperatingSystemVersion {
        majorVersion: MINIMUM_MACOS_ZOOM_MAJOR,
        minorVersion: 0,
        patchVersion: 0,
    };
    let is_supported = process_info.isOperatingSystemAtLeastVersion(minimum);
    let version = process_info.operatingSystemVersion();
    macos_zoom_support_error(is_supported, version.majorVersion, version.minorVersion)
}

#[cfg(not(target_os = "macos"))]
fn current_platform_zoom_support_error() -> Option<String> {
    None
}

/// 在系统支持时调用原生 WebView 缩放；macOS 10.15 不触碰 11.0 才引入的选择器。
pub fn apply_native_zoom<R: Runtime>(
    window: &WebviewWindow<R>,
    zoom_factor: f64,
) -> Result<(), String> {
    if let Some(error) = current_platform_zoom_support_error() {
        return Err(error);
    }
    window
        .set_zoom(zoom_factor)
        .map_err(|error| format!("ZOOM_APPLY_FAILED: {error}"))
}

pub const ZOOM_SHORTCUT_BRIDGE_JS: &str = r#"
(() => {
  if (window.parent === window || window.parent !== window.top) return;
  if (window.__dsh_zoom_shortcut_bridge__) return;
  window.__dsh_zoom_shortcut_bridge__ = true;

  window.addEventListener('keydown', (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;

    let action = null;
    if (event.key === '+' || event.key === '=') action = 'increase';
    else if (event.key === '-' || event.key === '_') action = 'decrease';
    else if (event.key === '0') action = 'reset';
    if (!action) return;

    event.preventDefault();
    window.parent.postMessage({
      source: 'dsh-zoom-shortcut-bridge',
      type: 'dsh://zoom-shortcut',
      action,
    }, '*');
  }, { capture: true });
})();
"#;

#[cfg(test)]
mod tests {
    use super::{macos_zoom_support_error, MINIMUM_MACOS_ZOOM_MAJOR, ZOOM_SHORTCUT_BRIDGE_JS};

    #[test]
    fn native_zoom_requires_macos_11_or_newer() {
        assert_eq!(MINIMUM_MACOS_ZOOM_MAJOR, 11);
        let error = macos_zoom_support_error(false, 10, 15).expect("Catalina must be rejected");
        assert!(error.starts_with("ZOOM_UNSUPPORTED_OS:"));
        assert!(error.contains("macOS 10.15"));
        assert!(macos_zoom_support_error(true, 11, 0).is_none());
        assert!(macos_zoom_support_error(true, 15, 4).is_none());
        assert!(macos_zoom_support_error(true, 10, 16).is_none());
    }

    #[test]
    fn bridge_is_idempotent_and_limited_to_direct_child_frames() {
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("window.__dsh_zoom_shortcut_bridge__"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("window.parent === window"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("window.parent !== window.top"));
    }

    #[test]
    fn bridge_filters_modifiers_and_known_zoom_keys() {
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.ctrlKey"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.metaKey"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.altKey"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.key === '+'"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.key === '-'"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.key === '0'"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("event.preventDefault()"));
        assert!(ZOOM_SHORTCUT_BRIDGE_JS.contains("dsh://zoom-shortcut"));
    }
}
