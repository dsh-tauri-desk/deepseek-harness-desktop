#[cfg(windows)]
use tauri::Manager;

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::{desktop::payload::NativeNotificationPayload, utils::app_icon_temp_path};

const MAX_NOTIFICATION_TITLE_CHARS: usize = 256;
const MAX_NOTIFICATION_BODY_CHARS: usize = 4_096;
const MAX_NOTIFICATION_TAG_CHARS: usize = 256;
const MAX_NOTIFICATION_SESSION_ID_CHARS: usize = 128;
const MAX_NOTIFICATION_SEQUENCE_CHARS: usize = 20;
const NOTIFICATION_RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_NOTIFICATIONS_PER_WINDOW: usize = 30;

struct NotificationRateLimiter {
    window_started: Instant,
    emitted: usize,
}

impl NotificationRateLimiter {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            emitted: 0,
        }
    }

    fn allow(&mut self) -> bool {
        if self.window_started.elapsed() >= NOTIFICATION_RATE_WINDOW {
            self.window_started = Instant::now();
            self.emitted = 0;
        }
        if self.emitted >= MAX_NOTIFICATIONS_PER_WINDOW {
            return false;
        }
        self.emitted += 1;
        true
    }
}

fn notification_rate_limiter() -> &'static Mutex<NotificationRateLimiter> {
    static LIMITER: OnceLock<Mutex<NotificationRateLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| Mutex::new(NotificationRateLimiter::new()))
}

fn valid_notification_identifier(value: &str, max_chars: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max_chars
        && value.is_ascii()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_notification_text(value: &str, max_chars: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.chars().count() <= max_chars
        && !value.contains('\0')
}

fn valid_sequence(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NOTIFICATION_SEQUENCE_CHARS
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// 校验 dsh-notification 约定的 tag，并返回其中的会话 id。
fn validate_notification_tag(tag: &str) -> Result<Option<&str>, String> {
    if !valid_notification_text(tag, MAX_NOTIFICATION_TAG_CHARS, false) {
        return Err("NOTIFICATION_INVALID_TAG: notification tag is not valid".to_string());
    }
    let Some(rest) = tag.strip_prefix("dsh-notification-") else {
        return Err("NOTIFICATION_INVALID_TAG: notification tag is not valid".to_string());
    };
    if let Some(sequence) = rest.strip_prefix("test-") {
        if valid_sequence(sequence) {
            return Ok(None);
        }
        return Err("NOTIFICATION_INVALID_TAG: notification tag is not valid".to_string());
    }

    let rest = rest.strip_prefix("pending-").unwrap_or(rest);
    let Some((session_id, sequence)) = rest.rsplit_once('-') else {
        return Err("NOTIFICATION_INVALID_TAG: notification tag is not valid".to_string());
    };
    if !valid_notification_identifier(session_id, MAX_NOTIFICATION_SESSION_ID_CHARS)
        || !valid_sequence(sequence)
    {
        return Err("NOTIFICATION_INVALID_TAG: notification tag is not valid".to_string());
    }
    Ok(Some(session_id))
}

fn validate_notification_payload(payload: &NativeNotificationPayload) -> Result<(), String> {
    if !valid_notification_text(&payload.title, MAX_NOTIFICATION_TITLE_CHARS, false) {
        return Err("NOTIFICATION_INVALID_TITLE: notification title is not valid".to_string());
    }
    if !valid_notification_text(&payload.body, MAX_NOTIFICATION_BODY_CHARS, true) {
        return Err("NOTIFICATION_INVALID_BODY: notification body is not valid".to_string());
    }

    let tag_session = payload
        .tag
        .as_deref()
        .map(validate_notification_tag)
        .transpose()?
        .flatten();
    match (payload.session_id.as_deref(), tag_session) {
        (Some(session_id), Some(tag_session)) => {
            if !valid_notification_identifier(session_id, MAX_NOTIFICATION_SESSION_ID_CHARS) {
                return Err(
                    "NOTIFICATION_INVALID_SESSION: notification session is not valid".to_string(),
                );
            }
            if tag_session != session_id {
                return Err(
                    "NOTIFICATION_INVALID_SESSION: notification session does not match tag"
                        .to_string(),
                );
            }
        }
        (Some(_), None) => {
            return Err(
                "NOTIFICATION_INVALID_SESSION: notification session requires a matching tag"
                    .to_string(),
            );
        }
        (None, Some(_)) => {
            return Err(
                "NOTIFICATION_INVALID_SESSION: notification session is missing".to_string(),
            );
        }
        (None, None) => {}
    }
    Ok(())
}

/// 如果 DSH 插件仍有兜底走浏览器 Notification，则保持“已授权”假象，
/// 并让每次 `new Notification(...)` 转成发给宿主窗口的 postMessage。
pub(crate) const NOTIFICATION_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_native_notification_bridge__) return;
  window.__dsh_native_notification_bridge__ = true;

  var hostHidden = false;
  var pendingOnClicks = {};

  function setHostHidden(hidden) {
    hidden = !!hidden;
    if (hostHidden === hidden) return;
    hostHidden = hidden;
    try { document.dispatchEvent(new Event('visibilitychange')); } catch (_) {}
  }

  function send(message) {
    try {
      window.parent.postMessage(Object.assign({ source: 'dsh-notification-bridge' }, message), '*');
    } catch (_) {}
  }

  function sessionIdFromTag(tag) {
    var m = /^dsh-notification-(?:pending-)?(.+)-\d+$/.exec(tag || '');
    if (!m || m[1] === 'test') return '';
    return m[1];
  }

  function DshNativeNotification(title, options) {
    options = options || {};
    this.title = String(title || '');
    this.options = options;
    this.tag = options.tag || '';
    this.onclick = null;
    this.onclose = null;
    this.onerror = null;
    this.onshow = null;

    if (this.tag) pendingOnClicks[this.tag] = this;

    send({
      type: 'dsh://native-notification',
      title: this.title,
      body: String(options.body || ''),
      tag: this.tag,
      requireInteraction: !!options.requireInteraction,
      sessionId: options.sessionId || sessionIdFromTag(this.tag),
      href: location.href,
      origin: location.origin
    });
  }

  DshNativeNotification.permission = 'granted';
  DshNativeNotification.requestPermission = function () {
    return Promise.resolve('granted');
  };
  DshNativeNotification.prototype.close = function () {
    if (this.tag) send({ type: 'dsh://close-notification', tag: this.tag });
  };

  window.Notification = DshNativeNotification;

  // 属性拦截：让 iframe 中的 visibilityState 强行跟随桌面宿主状态
  (function installHiddenOverrides() {
    var descMap = {
      hidden: { configurable: true, get: function () { return hostHidden; } },
      visibilityState: { configurable: true, get: function () { return hostHidden ? 'hidden' : 'visible'; } }
    };
    [document, Object.getPrototypeOf(document)].forEach(function (target) {
      if (!target) return;
      try {
        Object.defineProperty(target, 'hidden', descMap.hidden);
        Object.defineProperty(target, 'visibilityState', descMap.visibilityState);
      } catch (_) {}
    });
  })();

  window.addEventListener('blur', function () { setHostHidden(true); });
  window.addEventListener('focus', function () { setHostHidden(false); });

  // 查找并聚焦对应的 Session
  function tryFocusSession(sessionId, title) {
    if (!sessionId && !title) return;

    if (typeof window.__dsh_focusSession === 'function') {
      try { window.__dsh_focusSession(sessionId); return; } catch (_) {}
    }

    if (sessionId) {
      var el = document.querySelector('[data-session-id="' + sessionId + '"], [data-session="' + sessionId + '"], [data-id="' + sessionId + '"]');
      if (el) { el.click(); return; }
    }

    if (title) {
      var trimmedTitle = String(title).trim();
      var nodes = document.querySelectorAll('button, [role="button"], li, a');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].offsetParent !== null && nodes[i].textContent.trim() === trimmedTitle) {
          nodes[i].click();
          return;
        }
      }
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    switch (data.type) {
      case 'dsh://visibility-state':
        setHostHidden(data.hidden);
        break;
      case 'dsh://focus-session':
        tryFocusSession(data.sessionId, data.title);
        break;
      case 'dsh://notification-clicked':
        var instance = pendingOnClicks[data.tag];
        if (instance && typeof instance.onclick === 'function') {
          try { instance.onclick(new Event('click')); } catch (_) {}
        }
        break;
    }
  });
})();"#;

/// 在 Rust 侧显示一条系统原生通知。
#[tauri::command]
pub fn show_native_notification(
    app: tauri::AppHandle,
    payload: NativeNotificationPayload,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    validate_notification_payload(&payload)?;
    let allowed = notification_rate_limiter()
        .lock()
        .map(|mut limiter| limiter.allow())
        .unwrap_or(false);
    if !allowed {
        return Err("NOTIFICATION_RATE_LIMIT: notification rate limit exceeded".to_string());
    }

    let mut builder = app
        .notification()
        .builder()
        .title(payload.title)
        .body(payload.body);

    if let Some(icon_path) = app_icon_temp_path(&app) {
        builder = builder.icon(icon_path.to_string_lossy().into_owned());
    }

    if let Some(id) = payload.tag.as_deref().and_then(|t| t.parse::<i32>().ok()) {
        builder = builder.id(id);
    }

    builder
        .show()
        .map_err(|e| format!("NOTIFICATION_SHOW: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(tag: Option<&str>, session_id: Option<&str>) -> NativeNotificationPayload {
        NativeNotificationPayload {
            title: "DSH".to_string(),
            body: "done".to_string(),
            tag: tag.map(str::to_string),
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn notification_tags_follow_plugin_contract() {
        assert_eq!(
            validate_notification_tag("dsh-notification-session-1-2").unwrap(),
            Some("session-1")
        );
        assert_eq!(
            validate_notification_tag("dsh-notification-pending-session-1-3").unwrap(),
            Some("session-1")
        );
        assert_eq!(
            validate_notification_tag("dsh-notification-test-123").unwrap(),
            None
        );
        assert!(validate_notification_tag("arbitrary-tag").is_err());
        assert!(validate_notification_tag("dsh-notification-session-1-x").is_err());
    }

    #[test]
    fn notification_payload_requires_matching_session() {
        assert!(validate_notification_payload(&payload(
            Some("dsh-notification-session-1-2"),
            Some("session-1")
        ))
        .is_ok());
        assert!(
            validate_notification_payload(&payload(Some("dsh-notification-test-123"), None))
                .is_ok()
        );
        assert!(validate_notification_payload(&payload(
            Some("dsh-notification-session-1-2"),
            Some("session-2")
        ))
        .is_err());
        assert!(validate_notification_payload(&payload(None, Some("session-1"))).is_err());
    }
}

/// 在 Windows WebView2 中接管 iframe 内的通知请求并注入原生通知桥。
#[cfg(windows)]
pub fn enable_notification_permissions(
    webview: tauri::webview::PlatformWebview,
    parent: tauri::WebviewWindow<tauri::Wry>,
) -> Result<(), Box<dyn std::error::Error>> {
    use rfd::{MessageButtons, MessageDialog, MessageDialogResult};
    use webview2_com::{
        ExecuteScriptCompletedHandler, FrameContentLoadingEventHandler, FrameCreatedEventHandler,
        FramePermissionRequestedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Frame3, ICoreWebView2Profile4, ICoreWebView2_13, ICoreWebView2_4,
            COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
            COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DEFAULT, COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
        PermissionRequestedEventHandler, SetPermissionStateCompletedHandler,
    };
    use windows_core::{Interface, HSTRING};

    log::info!("[notification] registering WebView2 notification handlers");

    fn ask_notification_permission(parent: &tauri::WebviewWindow<tauri::Wry>) -> bool {
        MessageDialog::new()
            .set_parent(parent)
            .set_title("允许发送通知？")
            .set_description("DSH 页面请求发送桌面通知。是否允许？")
            .set_buttons(MessageButtons::YesNo)
            .show()
            == MessageDialogResult::Yes
    }

    fn notification_origins(parent: &tauri::WebviewWindow<tauri::Wry>) -> Vec<String> {
        let mut origins = vec![
            crate::config::get_dsh_service_url(crate::config::DSH_PORT),
            crate::config::get_dsh_service_url(crate::config::DSH_DEV_PORT),
        ];
        let store_port = crate::config::get_store_dat_setting(parent.app_handle()).port;
        let store_origin = crate::config::get_dsh_service_url(store_port);
        if !origins.contains(&store_origin) {
            origins.push(store_origin);
        }
        origins
    }

    fn permission_kinds() -> [COREWEBVIEW2_PERMISSION_KIND; 12] {
        [
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
        ]
    }

    fn should_allow_permission(kind: COREWEBVIEW2_PERMISSION_KIND) -> bool {
        matches!(
            kind,
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY
                | COREWEBVIEW2_PERMISSION_KIND_CAMERA
                | COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                | COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE
                | COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION
                | COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS
                | COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                | COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES
                | COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS
                | COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS
                | COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT
        )
    }

    unsafe fn reset_persisted_notification_permissions(
        webview2: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
        origins: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let webview13 = webview2.cast::<ICoreWebView2_13>()?;
        let profile = webview13.Profile()?;
        let Ok(profile4) = profile.cast::<ICoreWebView2Profile4>() else {
            log::warn!("[notification] ICoreWebView2Profile4 cast failed; skip reset.");
            return Ok(());
        };

        for origin in origins {
            for kind in permission_kinds() {
                let origin_str = origin.clone();
                let hstring = HSTRING::from(origin.as_str());
                // HSTRING 是引用计数类型，克隆只增加引用计数、共享底层缓冲区。
                // 回调（completed handler）是异步调用的，让克隆句柄随回调一起持有，
                // 避免 SetPermissionState 借用的句柄在回调存活期内失效。
                let hstring_for_callback = hstring.clone();
                let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                    COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                };

                log::info!("[permission] setting persisted permission for {origin_str}");
                profile4.SetPermissionState(
                    kind,
                    &hstring,
                    state,
                    &SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                        if let Err(e) = result {
                            log::warn!(
                                "[permission] failed to set permission for {origin_str}: {e}"
                            );
                        }
                        let _ = &hstring_for_callback;
                        Ok(())
                    })),
                )?;
            }
        }
        Ok(())
    }

    unsafe fn setup_frame_handlers(
        frame3: ICoreWebView2Frame3,
        parent: tauri::WebviewWindow<tauri::Wry>,
    ) {
        let parent_for_frame = parent.clone();
        let mut permission_token = 0i64;

        let _ = frame3.add_PermissionRequested(
            &FramePermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;

                    let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        if ask_notification_permission(&parent_for_frame) {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                    } else if should_allow_permission(kind) {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                    };
                    if kind != COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION {
                        args.SetState(state)?;
                        args.SetHandled(true)?;
                    }
                }
                Ok(())
            })),
            &mut permission_token,
        );

        let frame_for_injection = frame3.clone();
        let mut content_token = 0i64;

        let _ = frame3.add_ContentLoading(
            &FrameContentLoadingEventHandler::create(Box::new(move |_, _| {
                // 通知桥、导航桥、样式桥与缩放快捷键桥需要 iframe 上下文执行。
                for script in [
                    crate::desktop::notification::NOTIFICATION_SHIM_JS,
                    crate::desktop::nav::NAV_SHIM_JS,
                    crate::desktop::style::IFRAME_STYLES_JS,
                    crate::desktop::plugin_boot::PLUGIN_BOOT_RELOAD_JS,
                    crate::desktop::zoom::ZOOM_SHORTCUT_BRIDGE_JS,
                ] {
                    let script = HSTRING::from(script);
                    let _ = frame_for_injection.ExecuteScript(
                        &script,
                        &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                    );
                }
                Ok(())
            })),
            &mut content_token,
        );
    }

    let origins = notification_origins(&parent);
    let mut token = 0i64;

    unsafe {
        let controller = webview.controller();
        let webview2 = controller.CoreWebView2()?;

        if let Err(e) = reset_persisted_notification_permissions(&webview2, &origins) {
            log::warn!("[notification] failed to reset permissions: {e}");
        }

        // 1. 处理顶级页面权限请求
        let parent_for_top = parent.clone();
        webview2.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;

                    let state = if kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS {
                        if ask_notification_permission(&parent_for_top) {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                    } else if should_allow_permission(kind) {
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    } else {
                        COREWEBVIEW2_PERMISSION_STATE_DEFAULT
                    };
                    if kind != COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION {
                        args.SetState(state)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        // 2. 处理 iframe 页面权限与 JS 脚本注入
        if let Ok(webview4) = webview2.cast::<ICoreWebView2_4>() {
            let mut frame_created_token = 0i64;
            let parent_for_frame_created = parent.clone();

            webview4.add_FrameCreated(
                &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        if let Ok(frame) = args.Frame() {
                            if let Ok(frame3) = frame.cast::<ICoreWebView2Frame3>() {
                                setup_frame_handlers(frame3, parent_for_frame_created.clone());
                            }
                        }
                    }
                    Ok(())
                })),
                &mut frame_created_token,
            )?;
        }
    }

    Ok(())
}
