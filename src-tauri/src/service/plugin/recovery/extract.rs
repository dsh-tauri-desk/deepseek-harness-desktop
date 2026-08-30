//! 纯提取函数：从启动日志按错误特征正则提取插件引用与失败原因判别键。

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use super::is_actionable_plugin_ref;

/// 插件引用提取模式（编译一次复用，避免每次 `detect` 都重新编译正则）。
static PLUGIN_REF_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // failed to apply/import loader entry <name> (<pkg>)
        r#"failed to (?:apply|import) loader entry[^\n]*\(([^)]+)\)"#,
        // cannot resolve profile bundle "<pkg>"
        r#"cannot resolve profile bundle\s+["']?([^"'\n]+)["']?"#,
        // profile bundle "<pkg>" declares no dsh.bundle
        r#"profile bundle\s+["']?([^"'\n]+)["']?\s+declares no dsh\.bundle"#,
        // plugin(s) failed to load: <pkg>
        r#"plugins? failed to load:\s*([A-Za-z0-9@/_.\-]+)"#,
    ]
    .iter()
    .map(|p| Regex::new(p).expect("static plugin ref pattern"))
    .collect()
});

/// 「Failed to load plugins」错误卡片定位（紧随其后的若干行通常是包名）。
static RE_FAILED_TO_LOAD_PLUGINS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^Failed to load plugins\s*$").expect("literal"));

/// 重复前缀路由（classify_reason 用）。
static RE_DUP_PREFIX_ROUTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"duplicate prefix route\s+["']([^"']+)["']"#).expect("literal"));

/// 无法解析 profile bundle（classify_reason 用）。
static RE_CANNOT_RESOLVE_BUNDLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"cannot resolve profile bundle\s+["']?([^"'\n]+)["']?"#).expect("literal")
});

/// 从日志文本中提取插件引用（多个错误特征的正则，去重）。
pub(super) fn extract_plugin_refs(text: &str) -> Vec<String> {
    let mut refs = HashSet::new();
    for re in PLUGIN_REF_PATTERNS.iter() {
        for cap in re.captures_iter(text) {
            if let Some(m) = cap.get(1) {
                let cand = m.as_str().trim();
                if is_actionable_plugin_ref(cand) {
                    refs.insert(cand.to_string());
                }
            }
        }
    }
    // 「Failed to load plugins」错误卡片：紧随其后的若干行通常是包名。
    for m in RE_FAILED_TO_LOAD_PLUGINS.find_iter(text) {
        let rest = &text[m.end()..];
        for line in rest.lines().take(12) {
            let cand = line.trim().trim_end_matches(['.', ',', ' ']);
            if is_actionable_plugin_ref(cand) {
                refs.insert(cand.to_string());
            }
        }
    }
    refs.into_iter().collect()
}

/// 抽取「重复 loader entry id」。
pub(super) fn extract_duplicate_loader_entry(text: &str) -> Option<String> {
    let re = Regex::new(r#"duplicate loader entry id:\s*["']?([^"'\s]+)["']?"#).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// 抽取「界面槽位冲突」的槽位名。
pub(super) fn extract_slot_conflict(text: &str) -> Option<String> {
    let re = Regex::new(r#"single slot\s+["']([^"']+)["']\s+already has a registration"#).ok()?;
    if let Some(c) = re.captures(text) {
        return c.get(1).map(|m| m.as_str().trim().to_string());
    }
    let re = Regex::new(r#"UI slot\s+["']([^"']+)["']\s+has duplicate registrations"#).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// 对日志文本分类失败原因，返回（判别键, 动态详情）。
pub(super) fn classify_reason(text: &str) -> (String, String) {
    if let Some(c) = RE_DUP_PREFIX_ROUTE.captures(text) {
        let route = c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        return ("duplicate_route".into(), route);
    }
    if let Some(entry) = extract_duplicate_loader_entry(text) {
        return ("duplicate_loader_entry".into(), entry);
    }
    if let Some(c) = RE_CANNOT_RESOLVE_BUNDLE.captures(text) {
        return (
            "cannot_resolve_bundle".into(),
            c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
        );
    }
    if text.contains("declares no dsh.bundle") {
        let pkg = extract_plugin_refs(text)
            .into_iter()
            .next()
            .unwrap_or_default();
        return ("no_dsh_bundle".into(), pkg);
    }
    if let Some(slot) = extract_slot_conflict(text) {
        return ("slot_conflict".into(), slot);
    }
    if text.contains("failed to import loader entry")
        || text.contains("failed to apply loader entry")
    {
        return ("load_failed".into(), String::new());
    }
    ("unknown".into(), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_refs_from_failure_log() {
        let log = r#"
[stderr] failed to apply loader entry dshSidebarApi (@omdsh-dev/dsh-better-sidebar)
[stderr] cannot resolve profile bundle "dsh-web-ui-all"
"#;
        let refs = extract_plugin_refs(log);
        assert!(refs.contains(&"@omdsh-dev/dsh-better-sidebar".to_string()));
        assert!(refs.contains(&"dsh-web-ui-all".to_string()));
    }

    #[test]
    fn extract_refs_from_boot_card() {
        let log = "Failed to load plugins\ndsh-better-sidebar\n@scope/another\nAn unknown error occurred\n";
        let refs = extract_plugin_refs(log);
        assert!(refs.contains(&"dsh-better-sidebar".to_string()));
        assert!(refs.contains(&"@scope/another".to_string()));
        // 非包名行不应被当作插件引用
        assert!(!refs.iter().any(|r| r.contains("unknown")));
    }

    #[test]
    fn extract_duplicate_and_slot() {
        let route_log = r#"duplicate prefix route "/sidebar/api""#;
        assert_eq!(classify_reason(route_log).0, "duplicate_route");
        let entry_log = "duplicate loader entry id: \"dshSidebarApi\"";
        assert_eq!(
            extract_duplicate_loader_entry(entry_log).as_deref(),
            Some("dshSidebarApi")
        );
        let slot_log = r#"single slot "sidebar" already has a registration"#;
        assert_eq!(extract_slot_conflict(slot_log).as_deref(), Some("sidebar"));
    }
}
