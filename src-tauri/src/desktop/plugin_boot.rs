//! 官方 dsh boot 页卡在 “Loading plugins…” 时通知宿主执行有界恢复。
//!
//! 桌面端曾把 SPA `/` 的 200 当成就绪并立刻挂 iframe。连接桥尚未注册时，
//! boot 页会无限转圈（[#36](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/issues/36)、
//! [#42](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/issues/42)）；
//! 手动刷新即可恢复。本脚本只报告 stalled/ready，重试次数与后端就绪复检由宿主
//! 统一管理，避免 sessionStorage 的“一次机会”在客户端模块真正就绪前被消耗。
//!
//! 注入通道与 [`crate::desktop::nav::NAV_SHIM_JS`] 相同。

/// iframe 内：报告 boot 页 stalled/ready；每个文档只报告一次 stalled。
pub(crate) const PLUGIN_BOOT_RELOAD_JS: &str = r#"(function () {
  if (window.__dsh_plugin_boot_reload__) return;
  window.__dsh_plugin_boot_reload__ = true;
  if (window === window.top) return;

  var stopped = false;
  var sawSplash = false;
  var stalledTimer = null;
  var readyTimer = null;

  function isSplash() {
    var text = (document.body && (document.body.innerText || document.body.textContent)) || '';
    return text.indexOf('Loading plugins') !== -1;
  }

  function send(type) {
    try {
      window.parent.postMessage({
        source: 'dsh-plugin-boot-bridge',
        type: type
      }, '*');
    } catch (_) {}
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (stalledTimer !== null) clearTimeout(stalledTimer);
    if (readyTimer !== null) clearInterval(readyTimer);
  }

  stalledTimer = setTimeout(function () {
    if (stopped || !isSplash()) return;
    sawSplash = true;
    send('dsh://plugin-boot:stalled');
  }, 8000);

  readyTimer = setInterval(function () {
    if (stopped) return;
    if (isSplash()) {
      sawSplash = true;
      return;
    }
    if (!sawSplash) return;
    send('dsh://plugin-boot:ready');
    stop();
  }, 1000);

  window.addEventListener('pagehide', stop, { once: true });
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_reload_script_reports_stalled_and_ready_without_self_reload() {
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("__dsh_plugin_boot_reload__"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("Loading plugins"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("dsh://plugin-boot:stalled"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("dsh://plugin-boot:ready"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("sawSplash"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("window === window.top"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("pagehide"));
        assert!(!PLUGIN_BOOT_RELOAD_JS.contains("location.reload"));
    }
}
