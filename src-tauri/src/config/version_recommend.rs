//! DSH 核心推荐版本配置读取。
//!
//! 配置随应用资源分发，开发构建回落到源码 resources 目录；读取失败时不限制
//! 版本，避免配置损坏阻断核心管理。

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "version-recommend.json";

#[derive(Debug, Default, Deserialize)]
struct VersionRecommend {
    dsh: Option<String>,
}

/// 查找推荐版本清单，兼容 Tauri 资源目录的扁平与 resources/ 嵌套布局。
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

fn manifest_path(app_handle: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = app_handle.path().resource_dir() {
        for path in [root.join(FILE_NAME), root.join("resources").join(FILE_NAME)] {
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(FILE_NAME);
    source.is_file().then_some(source)
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
    use super::{is_version_above, parse_recommended_version};

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
