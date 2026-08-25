//! Debug 客户端插件重载兼容补丁。
//!
//! 当前内置 DSH `0.1.1-rc.2` 的 client-HMR 在收到 `rebuilt` 后会卸载旧插件，
//! 但第三方插件的 Loader 条目不会重新挂载，表现为构建后插件消失、手动刷新才恢复。
//! debug 桌面端本来就直接联接本地插件源码，因此将该坏 hot-swap 降级为页面自动刷新：
//! 仍由 `/plugins/events` 精确触发，不轮询页面，也不会影响 release。

use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::service::core::{active_source, local_core_package_dir, CoreSource};

// HARDCODE：以下锚点绑定内置 DSH 0.1.1-rc.2 的 client-HMR bundle；仅 debug 生效。
const PATCH_MARKER: &str = "dsh-tauri-desktop: debug client plugin reload fallback";
const ORIGINAL: &str = r#"case "rebuilt":
						queue = queue.then(() => reload(frame.id)).catch((error) => {
							ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`);
							ctx.logger.error(error);
						});
						break;"#;
const PATCHED: &str = r#"case "rebuilt":
						/* dsh-tauri-desktop: debug client plugin reload fallback */
						window.location.reload();
						break;"#;

#[derive(Debug, PartialEq, Eq)]
enum PatchOutcome {
    AlreadyPatched,
    AnchorMissing,
    Patched(String),
}

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(ORIGINAL) {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(source.replacen(ORIGINAL, PATCHED, 1))
}

/// debug 启动前把损坏的插件 hot-swap 降级为自动页面刷新。
#[cfg(debug_assertions)]
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let client_js = active_core_install_dir(app_handle)
        .join("node_modules/@deepseek-ai/dsh-client-hmr/lib/client.js");
    if !client_js.exists() {
        log::info!(
            "client-hmr client.js not found, skip debug reload patch: {}",
            client_js.display()
        );
        return Ok(());
    }
    let source = fs::read_to_string(&client_js)
        .map_err(|e| format!("CLIENT_HMR_PATCH_READ: {} failed: {e}", client_js.display()))?;
    match patch_source(&source) {
        PatchOutcome::AlreadyPatched => {
            log::info!("debug client plugin reload fallback already applied")
        }
        PatchOutcome::AnchorMissing => log::warn!(
            "debug client plugin reload fallback anchor missing, skip patch: {}",
            client_js.display()
        ),
        PatchOutcome::Patched(patched) => {
            fs::write(&client_js, patched).map_err(|e| {
                format!(
                    "CLIENT_HMR_PATCH_WRITE: {} failed: {e}",
                    client_js.display()
                )
            })?;
            log::info!(
                "debug client plugin reload fallback patched: {}",
                client_js.display()
            );
        }
    }
    Ok(())
}

/// release 不修改客户端重载行为。
#[cfg(not(debug_assertions))]
pub fn apply(_app_handle: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

fn active_core_install_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core_package_dir(app_handle)
            .unwrap_or_else(|| config::get_dsh_install_path(app_handle)),
        CoreSource::App => config::get_dsh_install_path(app_handle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_broken_hot_swap_with_page_reload() {
        let PatchOutcome::Patched(patched) = patch_source(ORIGINAL) else {
            panic!("expected patched source");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains("window.location.reload();"));
        assert!(!patched.contains("queue = queue.then"));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(ORIGINAL) else {
            panic!("expected patched source");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_unknown_upstream_layout() {
        assert_eq!(
            patch_source("case \"rebuilt\": break;"),
            PatchOutcome::AnchorMissing
        );
    }
}
