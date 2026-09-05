//! 从 dsh stdout 解析「带 token 的本地访问 URL」并通知前端。
//!
//! `dsh web` 启动后向 stdout 输出一行：
//!   `dsh web: http://127.0.0.1:3080/?token=XXX (LAN: http://10.0.0.5:3080/?token=XXX)`
//! 桌面端 iframe 需要这个 URL（alpha 浏览器会话鉴权），之前没解析、永远走
//! 端口 fallback URL，鉴权失败 → 卡 "Loading plugins…"。

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

pub const URL_EVENT: &str = "harness-url-detected";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlPayload {
    pub url: String,
    /// 与 url_slot::bump_generation 同时返回的代号。前端用它丢弃 race 下的
    /// 迟到事件：emit 已入 IPC 队列、bump_generation 已发生、事件才送达的场景
    /// （后端 try_set 已经按 generation 拦过一次，这里是双保险）。
    pub generation: u64,
}

fn re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"dsh web:\s*(https?://(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d+(?:[/?][^\s]*)?)")
            .expect("harness-url regex compiles")
    })
}

/// 从单行 stdout 提取 URL。容忍行内 LAN 段、尾随逗号/分号。
pub fn extract(line: &str) -> Option<String> {
    let raw = re().captures(line)?.get(1)?.as_str();
    // LAN 段以空格起、首字符 '('，统一按空白切掉；尾随标点用 trim_end_matches 剥。
    let head = raw.split_whitespace().next()?;
    let trimmed = head.trim_end_matches([',', ';']);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 把 URL 写到槽位并通知前端。generation 由调用方传入（来自 url_slot::bump_generation）。
/// 槽位写入失败（generation 过期）不通知前端——避免旧进程 stdout 行污染新会话 UI。
pub fn emit_url_changed(app_handle: &AppHandle, url: &str, generation: u64) {
    if !super::url_slot::try_set(url.to_string(), generation) {
        return;
    }
    let _ = app_handle.emit(URL_EVENT, UrlPayload {
        url: url.to_string(),
        generation,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_token_url() {
        assert_eq!(
            extract("dsh web: http://127.0.0.1:3080/?token=abc"),
            Some("http://127.0.0.1:3080/?token=abc".into()),
        );
    }

    #[test]
    fn strips_lan_suffix() {
        let line = "dsh web: http://127.0.0.1:3080/?token=xyz (LAN: http://10.0.0.5:3080/?token=xyz)";
        let url = extract(line).unwrap();
        assert!(url.starts_with("http://127.0.0.1:3080"));
        assert!(url.contains("?token=xyz"));
        assert!(!url.contains("LAN"), "LAN 段必须被剥离: {url}");
    }

    #[test]
    fn strips_trailing_punctuation() {
        assert_eq!(
            extract("dsh web: http://127.0.0.1:3080/?token=abc,").as_deref(),
            Some("http://127.0.0.1:3080/?token=abc"),
        );
        assert_eq!(
            extract("dsh web: http://127.0.0.1:3080/?token=abc;").as_deref(),
            Some("http://127.0.0.1:3080/?token=abc"),
        );
    }

    #[test]
    fn no_token_still_matches() {
        assert_eq!(
            extract("dsh web: http://127.0.0.1:3081/").as_deref(),
            Some("http://127.0.0.1:3081/"),
        );
    }

    #[test]
    fn accepts_localhost_and_all_interfaces() {
        assert_eq!(
            extract("dsh web: http://localhost:3080/?token=x").as_deref(),
            Some("http://localhost:3080/?token=x"),
        );
        assert_eq!(
            extract("dsh web: http://0.0.0.0:3080/?token=x").as_deref(),
            Some("http://0.0.0.0:3080/?token=x"),
        );
    }

    #[test]
    fn ignores_non_dsh_lines() {
        assert!(extract("http://127.0.0.1:3080/?token=abc").is_none());
        assert!(extract("loading http://example.com").is_none());
        assert!(extract("dsh web: opening the default browser; pass --no-open").is_none());
    }

    #[test]
    fn regex_compiles() {
        // 一旦正则编译失败会让整个进程无法启动，单测守住这个不变量。
        assert!(re().is_match("dsh web: http://127.0.0.1:3080/"));
        assert!(!re().is_match("not a dsh web line"));
    }
}
