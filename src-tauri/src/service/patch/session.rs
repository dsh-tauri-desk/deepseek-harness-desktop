//! Adds the missing public SessionStore removal primitive to the bundled DSH.
//!
//! The upstream store already owns the exact detach lifecycle; this patch only
//! exposes a narrow id-based facade for desktop plugins to use safely.

use crate::utils::{patch_dsh, PatchOutcome};

const PATCH_MARKER: &str = "dsh-tauri-desktop: SessionStore.remove";
const ANCHOR: &str =
    "/** Remove one exact entered session and emit its paired disposal when announced. */";
const INSERTION: &str = r#"/** Remove one live session by id and run its official detach lifecycle. */
	remove(id) {
		const entry = this.store.get(id);
		if (entry === void 0) return false;
		entry.detach();
		return true;
	}
	/** Remove one exact entered session and emit its paired disposal when announced. */"#;

/// 相对活动核心安装目录的 session `lib/index.js` 包内路径。
const SESSION_INDEX_JS: &str = "node_modules/@deepseek-ai/dsh-session/lib/index.js";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(ANCHOR) {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(source.replacen(ANCHOR, &format!("{INSERTION} /* {PATCH_MARKER} */"), 1))
}

/// 对活动核心的 dsh-session `lib/index.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, SESSION_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_remove_method() {
        let source = format!("{ANCHOR}\n");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected patch")
        };
        assert!(patched.contains("remove(id)"));
        assert!(patched.contains(PATCH_MARKER));
    }

    #[test]
    fn patch_is_idempotent() {
        let source = format!("{ANCHOR}\n");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected patch")
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }
}
