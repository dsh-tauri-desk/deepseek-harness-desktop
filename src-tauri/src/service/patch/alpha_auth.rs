//! alpha 核心的桌面嵌入鉴权兼容补丁。
//!
//! alpha 的 `dsh-client-connection` 默认要求浏览器先用启动 token 换取
//! `SameSite=Strict` Cookie。桌面端通过跨上下文 iframe 承载 Web UI，无法稳定
//! 完成该 Cookie 交换，因此仅在命中 alpha 专有锚点时跳过 browser-session 层。
//! Host/Origin/loopback 信任边界仍由 `isTrustedApiRequest` 保留。

use crate::utils::{patch_dsh, PatchOutcome};

const PATCH_MARKER: &str = "dsh-tauri-desktop: alpha embedded auth bypass";
const CLIENT_CONNECTION_INDEX_JS: &str =
    "node_modules/@deepseek-ai/dsh-client-connection/lib/index.js";

// alpha 专有错误文案：旧版没有该鉴权实现，不允许仅凭通用方法名误打补丁。
const ALPHA_AUTH_ANCHOR: &str =
    "dsh web authentication required; reopen the URL printed by dsh web.";
const AUTHORIZE_ANCHOR: &str = "\tauthorizeIndex(req, res) {";
const AUTHORIZE_END: &str = "\n\t}\n\t/**\n\t* Verify the authority-bound browser cookie";
const REJECTION_ANCHOR: &str = "\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n\t}";
const REJECTION_PATCHED: &str = "\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn void 0;\n\t} /* dsh-tauri-desktop: alpha embedded auth bypass */";

/// 替换 alpha 的 index 与 API browser-session 鉴权，同时保留 Host/Origin fence。
fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(ALPHA_AUTH_ANCHOR)
        || !source.contains(AUTHORIZE_ANCHOR)
        || !source.contains(AUTHORIZE_END)
        || !source.contains(REJECTION_ANCHOR)
    {
        return PatchOutcome::AnchorMissing;
    }

    let authorize_start = source
        .find(AUTHORIZE_ANCHOR)
        .expect("checked authorize anchor");
    let authorize_body_start = authorize_start + AUTHORIZE_ANCHOR.len();
    let authorize_end = source[authorize_body_start..]
        .find(AUTHORIZE_END)
        .map(|offset| authorize_body_start + offset)
        .expect("checked authorize end anchor");
    // 结束锚点从原方法的闭合 `}` 开始，因此这里只替换方法体，不重复插入闭合括号。
    let authorize_replacement = "\n\t\treturn true;";

    let mut patched = source.to_string();
    patched.replace_range(
        authorize_start + AUTHORIZE_ANCHOR.len()..authorize_end,
        authorize_replacement,
    );
    patched = patched.replacen(REJECTION_ANCHOR, REJECTION_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

/// 对活动核心的 alpha `dsh-client-connection` 应用桌面嵌入鉴权补丁。
/// 文件缺失或任一锚点变化时安全跳过，不阻断启动。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT_CONNECTION_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha_fixture() -> String {
        format!(
            "{AUTHORIZE_ANCHOR}\n\t\tconst url = new URL(req.url ?? \"/\", \"http://dsh.invalid\");\n\t\tthis.writeUnauthorized(req, res);\n\t}}\n\t/**\n\t* Verify the authority-bound browser cookie\n{REJECTION_ANCHOR}\n{ALPHA_AUTH_ANCHOR}\n"
        )
    }

    #[test]
    fn patches_alpha_index_and_api_auth_but_keeps_trust_fence() {
        let PatchOutcome::Patched(patched) = patch_source(&alpha_fixture()) else {
            panic!("expected alpha patch");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains("authorizeIndex(req, res) {\n\t\treturn true;"));
        assert!(
            patched.contains("if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;")
        );
        assert!(patched
            .contains("return void 0;\n\t} /* dsh-tauri-desktop: alpha embedded auth bypass */"));
        assert!(!patched.contains("this.browserAuth.isAuthenticated(request) ? void 0 : 401"));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&alpha_fixture()) else {
            panic!("expected alpha patch");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn legacy_or_changed_layout_is_untouched() {
        assert_eq!(
            patch_source("authorizeIndex(req, res) {}"),
            PatchOutcome::AnchorMissing
        );
        let mut partial = alpha_fixture();
        partial = partial.replace(ALPHA_AUTH_ANCHOR, "legacy web page");
        assert_eq!(patch_source(&partial), PatchOutcome::AnchorMissing);
        let partial = alpha_fixture().replace(
            REJECTION_ANCHOR,
            "requestRejection(request) { return 401; }",
        );
        assert_eq!(patch_source(&partial), PatchOutcome::AnchorMissing);
    }
}
