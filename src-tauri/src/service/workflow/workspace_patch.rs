//! Workspace 会话归属补丁：允许显式 attach 的会话使用不同于 Workspace 的 cwd。
//!
//! worktree 会话必须以隔离目录作为 `session.header.cwd`，但产品上仍应归属源项目的
//! Workspace。上游 `@deepseek-ai/dsh-workspace` 同时在 attach、getter 与 mutate 三处按
//! `cwd === workspace.path` 过滤，导致合法 worktree 会话只能落入“未分组”。本补丁仅
//! 放宽显式 attach 后的归属保持；cwd 缺失、无法解析或不是目录的安全校验仍由上游保留。

use std::fs;
use std::path::PathBuf;

use crate::config;
use crate::service::core::{active_source, local_core_package_dir, CoreSource};

// HARDCODE：以下锚点绑定内置 DSH 0.1.1-rc.2 的压缩后源码；锚点变化时安全跳过并告警。
const PATCH_MARKER: &str = "dsh-tauri-worktree: relaxed explicit workspace membership";
const GETTER_ORIGINAL: &str =
    "return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);";
const GETTER_PATCHED: &str = "return this.record.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";
const ATTACH_ORIGINAL: &str = "if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);";
const ATTACH_PATCHED: &str = "/* dsh-tauri-worktree: relaxed explicit workspace membership */";
const MUTATE_ORIGINAL: &str = "const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);";
const MUTATE_PATCHED: &str = "const sessionIds = changed.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";

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
    if !source.contains(GETTER_ORIGINAL)
        || !source.contains(ATTACH_ORIGINAL)
        || !source.contains(MUTATE_ORIGINAL)
    {
        return PatchOutcome::AnchorMissing;
    }
    let patched = source
        .replacen(GETTER_ORIGINAL, GETTER_PATCHED, 1)
        .replacen(ATTACH_ORIGINAL, ATTACH_PATCHED, 1)
        .replacen(MUTATE_ORIGINAL, MUTATE_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let workspace_js = active_core_install_dir(app_handle)
        .join("node_modules/@deepseek-ai/dsh-workspace/lib/index.js");
    if !workspace_js.exists() {
        log::info!(
            "workspace index.js not found, skip worktree membership patch: {}",
            workspace_js.display()
        );
        return Ok(());
    }
    let source = fs::read_to_string(&workspace_js).map_err(|e| {
        format!(
            "WORKSPACE_PATCH_READ: {} failed: {e}",
            workspace_js.display()
        )
    })?;
    match patch_source(&source) {
        PatchOutcome::AlreadyPatched => {
            log::info!("workspace worktree membership patch already applied")
        }
        PatchOutcome::AnchorMissing => log::warn!(
            "workspace worktree membership anchors missing, skip patch: {}",
            workspace_js.display()
        ),
        PatchOutcome::Patched(patched) => {
            fs::write(&workspace_js, patched).map_err(|e| {
                format!(
                    "WORKSPACE_PATCH_WRITE: {} failed: {e}",
                    workspace_js.display()
                )
            })?;
            log::info!(
                "workspace worktree membership patched: {}",
                workspace_js.display()
            );
        }
    }
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

    fn fixture() -> String {
        format!("{GETTER_ORIGINAL}\n{ATTACH_ORIGINAL}\n{MUTATE_ORIGINAL}\n")
    }

    #[test]
    fn patches_all_three_membership_guards() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert!(patched.contains(GETTER_PATCHED));
        assert!(patched.contains(ATTACH_PATCHED));
        assert!(patched.contains(MUTATE_PATCHED));
        assert!(!patched.contains(GETTER_ORIGINAL));
        assert!(!patched.contains(ATTACH_ORIGINAL));
        assert!(!patched.contains(MUTATE_ORIGINAL));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_partial_upstream_layout() {
        assert_eq!(patch_source(GETTER_ORIGINAL), PatchOutcome::AnchorMissing);
    }
}
