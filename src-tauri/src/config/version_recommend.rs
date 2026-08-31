//! DSH 核心推荐版本配置读取。
//!
//! 配置随应用资源分发，开发构建优先使用源码 resources 目录；读取失败时不限制
//! 版本，避免配置损坏阻断核心管理。

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "version-recommend.json";

#[derive(Debug, Default, Deserialize)]
struct VersionRecommend {
    dsh: Option<String>,
}

/// 解析推荐版本清单内容。
fn parse_recommended_version(content: &str) -> Option<String> {
    let config: VersionRecommend = serde_json::from_str(content).ok()?;
    let version = config.dsh?.trim().to_string();
    (!version.is_empty() && semver::Version::parse(&version).is_ok()).then_some(version)
}

fn is_version_above(version: &str, recommended: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(recommended),
    ) {
        (Ok(actual), Ok(recommended)) => actual > recommended,
        _ => false,
    }
}

fn manifest_candidates(source: PathBuf, resource_root: Option<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // 开发版的 resource_dir 可能来自旧的构建产物；首次安装必须以当前 checkout
    // 中的清单为准，否则会用过期版本的摘要校验当前下载内容，稳定触发 mismatch。
    if cfg!(debug_assertions) {
        paths.push(source.clone());
    }
    if let Some(root) = resource_root {
        paths.extend([root.join(FILE_NAME), root.join("resources").join(FILE_NAME)]);
    }
    if !cfg!(debug_assertions) {
        paths.push(source);
    }
    paths
}

fn manifest_path(app_handle: &AppHandle) -> Option<PathBuf> {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(FILE_NAME);
    manifest_candidates(source, app_handle.path().resource_dir().ok())
        .into_iter()
        .find(|path| path.is_file())
}

/// 返回配置中的推荐 DSH 版本。
pub fn recommended_dsh_version(app_handle: &AppHandle) -> Option<String> {
    let path = manifest_path(app_handle)?;
    let content = std::fs::read_to_string(&path).ok()?;
    parse_recommended_version(&content)
}

/// 判断版本是否高于推荐版本；任一版本无法解析时返回 false。
pub fn is_above_recommended(app_handle: &AppHandle, version: &str) -> bool {
    let Some(recommended) = recommended_dsh_version(app_handle) else {
        return false;
    };
    is_version_above(version, &recommended)
}

#[cfg(test)]
mod tests {
    use super::{is_version_above, manifest_candidates, parse_recommended_version};
    use std::path::PathBuf;

    #[test]
    fn development_manifest_candidates_prioritize_source_resources() {
        let source = PathBuf::from(r"checkout\src-tauri\resources\version-recommend.json");
        let bundled = PathBuf::from(r"target\debug\resources");
        let candidates = manifest_candidates(source.clone(), Some(bundled));

        if cfg!(debug_assertions) {
            assert_eq!(candidates.first(), Some(&source));
        } else {
            assert_ne!(candidates.first(), Some(&source));
        }
    }

    #[test]
    fn parses_valid_recommendation_and_trims_whitespace() {
        assert_eq!(
            parse_recommended_version(r#"{ "dsh": " 0.1.1-rc.2 " }"#),
            Some("0.1.1-rc.2".to_string())
        );
    }

    #[test]
    fn rejects_missing_or_invalid_recommendation() {
        assert_eq!(parse_recommended_version(r#"{ "dsh": "latest" }"#), None);
        assert_eq!(parse_recommended_version(r#"{}"#), None);
        assert_eq!(parse_recommended_version("not json"), None);
    }

    #[test]
    fn compares_semver_without_treating_invalid_versions_as_risky() {
        assert!(is_version_above("0.1.1-rc.3", "0.1.1-rc.2"));
        assert!(!is_version_above("0.1.1-rc.2", "0.1.1-rc.2"));
        assert!(!is_version_above("0.1.1-rc.1", "0.1.1-rc.2"));
        assert!(!is_version_above("invalid", "0.1.1-rc.2"));
    }
}
