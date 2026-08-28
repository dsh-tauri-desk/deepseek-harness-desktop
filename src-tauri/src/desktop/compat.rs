//! WebKit 兼容桥：为旧版 WebKit（< Safari 17.4）补齐 `AbortSignal.any`。
//!
//! 背景：dsh 的浏览器端代码（`dsh-client-connection` 的 fetch carrier、
//! `dsh-api-gateway` 等）直接调用 `AbortSignal.any([AbortSignal.timeout(...), signal])`
//! 做超时与主叫方取消信号的合并。`AbortSignal.any` 是 Safari 17.4+ / WebKit 2603 才
//! 引入的标准 API，macOS 14.x（系统 WebKit 17.3，Safari 17.3）以及一部分旧版
//! WebKitGTK（Linux）上不存在，导致桌面 WebView 抛出
//! `AbortSignal.any is not a function. (In '...', 'AbortSignal.any' is undefined)`。
//!
//! 本脚本与 [`crate::desktop::nav::NAV_SHIM_JS`] / [`crate::desktop::style::IFRAME_STYLES_JS`]
//! 走同一套注入通道（Windows 在 FrameCreated → ContentLoading 时 ExecuteScript，
//! 其余平台 `initialization_script_for_all_frames`），在 dsh 页面脚本执行之前
//! 就位，因此主机框架与 iframe 每次重新加载都会自动重建。
//!
//! 实现只用 ES5 兼容的语法（var / function / Array.prototype 方法），
//! 保证即便在旧 WebKit 的严格模式环境下也能解析执行；带幂等守卫
//! （`window.__dsh_abortsignal_any__`），重复注入安全——宿主页面若已自带
//! polyfill（部分 dsh 发行版在 index.html 里内联过 `data-codex-abortsignal-polyfill`），
//! 本脚本会自动让位，不会覆盖原生或已存在的实现。

/// 注入 `AbortSignal.any` 的幂等 polyfill（WebKit 17.3 / WebKitGTK 缺失时启用）。
///
/// 仅在非 Windows 平台注入（`[`crate::desktop::builder`] 的
/// `initialization_script_for_all_frames`）；Windows 使用 WebView2（Chromium），
/// 原生支持 `AbortSignal.any`，无需此 polyfill，故该常量不参与 Windows 构建。
#[cfg(not(windows))]
pub(crate) const ABORT_SIGNAL_ANY_SHIM_JS: &str = r#"(function () {
  if (window.__dsh_abortsignal_any__) return;
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.any === 'function') return;
  window.__dsh_abortsignal_any__ = true;

  var polyfillAny = function (signals) {
    var list = Array.prototype.slice.call(signals);
    var controller = new AbortController();

    function cleanup() {
      for (var i = 0; i < list.length; i++) {
        var signal = list[i];
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      }
    }

    function onAbort(event) {
      cleanup();
      controller.abort(event.target && event.target.reason);
    }

    for (var j = 0; j < list.length; j++) {
      var candidate = list[j];
      if (candidate && candidate.aborted) {
        onAbort({ target: candidate });
        break;
      }
      if (candidate && typeof candidate.addEventListener === 'function') {
        candidate.addEventListener('abort', onAbort, { once: true });
      }
    }
    return controller.signal;
  };

  try {
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      writable: true,
      value: polyfillAny,
    });
  } catch (_e) {
    // 极端情况下（非常老的非标准 AbortSignal 对象拒绝 defineProperty）
    // 直接赋值回退；若仍失败则保持原状，不做额外处理。
    try {
      AbortSignal.any = polyfillAny;
    } catch (_ignored) { /* 保留原生未定义的现状 */ }
  }
})();"#;
