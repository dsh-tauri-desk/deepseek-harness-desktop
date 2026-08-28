//! 官方 dsh boot 页卡在 “Loading plugins…” 时通知宿主执行有界恢复。
//!
//! 脚本仅精确识别 `#root` 下单一 boot 根节点的 HARNESS wordmark 与 Loading
//! plugins 提示；普通页面正文出现同名文本不会触发。计时从 splash 首次被观察到
//! 才开始，消失后撤销，晚出现或再次出现都可重新计时；正常应用 shell 挂载后永久
//! 停止观察。

/// iframe 内：报告 boot 页 stalled/ready；实际重载预算由宿主管理。
pub(crate) const PLUGIN_BOOT_RELOAD_JS: &str = include_str!("plugin_boot.js.inc");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_bridge_uses_exact_dom_and_cleans_up_without_self_reload() {
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("getElementById('root')"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("isOfficialSplash"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("isApplicationShell"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("MutationObserver"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("pagehide"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("dsh://plugin-boot:stalled"));
        assert!(PLUGIN_BOOT_RELOAD_JS.contains("dsh://plugin-boot:ready"));
        assert!(!PLUGIN_BOOT_RELOAD_JS.contains("body.innerText"));
        assert!(!PLUGIN_BOOT_RELOAD_JS.contains("location.reload"));
    }
}
