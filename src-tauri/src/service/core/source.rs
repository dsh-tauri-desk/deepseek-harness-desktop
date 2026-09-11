//! 核心来源判定与「当前活动核心」入口选择。
//!
//! 承载 [`CoreSource`] / [`HarnessCore`] 两个公开类型，以及
//! [`active_source`] / [`active_dsh_binary`] / [`active_version`] 三个供服务启动
//! 与插件操作统一取用的入口。本地核心探测见 [`super::local`]。

use crate::config;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::local::local_core;
use crate::service::download::parse_version_from_tag;

/// 核心来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreSource {
    /// 用户通过 CLI 安装的本地核心
    Local,
    /// 桌面端预打包核心
    App,
}

impl CoreSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreSource::Local => "local",
            CoreSource::App => "app",
        }
    }

    pub fn parse(source: &str) -> Option<CoreSource> {
        match source {
            "local" => Some(CoreSource::Local),
            "app" => Some(CoreSource::App),
            _ => None,
        }
    }
}

/// 核心列表项（序列化 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCore {
    /// `local` | `app`（无 tag 记录的旧激活行）| `app-<tag>`
    pub id: String,
    pub source: CoreSource,
    /// 版本号（不含 `v` 前缀；缺失为空串）
    pub version: String,
    /// 完整 release tag（如 `dsh-0.1.0-rc.8-32331963388`；local 行为空串）
    pub tag: String,
    /// 核心入口（cli path）：本地核心为 bin.js 绝对路径，预打包为安装目录
    pub path: String,
    /// 「打开目录」入口：本地核心为包目录，预打包为安装/槽位目录；未下载为空
    pub dir: String,
    /// 本地是否可用（文件在盘/可解析）
    pub present: bool,
    /// 当前是否使用中的核心
    pub active: bool,
    /// 是否预览版（GitHub Release 标记 Pre-release，或 tag 命名含预览标记，见
    /// `download::is_preview_tag`）：预览版不参与自动更新提示，但可在核心列表
    /// 手动下载安装，并以「预览版」标签展示。
    pub preview: bool,
    /// 当前版本是否高于资源清单中的推荐版本。
    pub above_recommended: bool,
    /// 本地存在但远程 pkg 仓库已不再提供的历史槽位。
    pub orphaned: bool,
    /// 资源清单中的推荐版本，用于切换前风险提示。
    pub recommended_version: Option<String>,
    pub error: Option<String>,
}

/// 当前活动核心来源（需求 3：本地核心存在时优先，除非用户显式选择预打包）。
pub fn active_source(app_handle: &AppHandle) -> CoreSource {
    let setting = config::get_store_dat_setting(app_handle);
    let local_present = local_core(app_handle).is_some();
    match setting.active_core.as_deref().and_then(CoreSource::parse) {
        Some(CoreSource::App) => CoreSource::App,
        // 显式选择本地但本地已失效 → 回退预打包
        Some(CoreSource::Local) if local_present => CoreSource::Local,
        // 未设置（自动）或显式本地已失效：本地存在时优先
        _ => {
            if local_present {
                CoreSource::Local
            } else {
                CoreSource::App
            }
        }
    }
}

/// 当前活动核心的 dsh 入口（bin.js 绝对路径）。
///
/// 供服务启动（workflow::launch）与插件操作（plugin::install 等）统一取用，
/// 本地核心解析在调用瞬间失效时回退预打包入口。
pub fn active_dsh_binary(app_handle: &AppHandle) -> PathBuf {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle)
            .map(|c| c.bin)
            .unwrap_or_else(|| config::get_dsh_binary_path(app_handle)),
        CoreSource::App => config::get_dsh_binary_path(app_handle),
    }
}

/// 从 DSH 核心入口所属的 `@deepseek-ai/dsh/package.json` 读取真实版本号。
///
/// 这里读取的是桌面端将要启动的核心引擎本身，而不是 `active_core` / `dsh_pkg_tag`
/// 等桌面端选择记录；后者可能滞后于磁盘上的核心文件，不能作为插件兼容性判断依据。
pub fn dsh_engine_version_from_binary(binary: &Path) -> Option<String> {
    let package_dir = binary.parent()?.parent()?;
    let content = fs::read_to_string(package_dir.join("package.json")).ok()?;
    let manifest = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    let version = manifest
        .get("version")
        .and_then(|value| value.as_str())?
        .trim();

    semver::Version::parse(version)
        .ok()
        .map(|version| version.to_string())
}

/// 当前桌面端正在使用的 DSH 核心引擎版本。
pub fn active_engine_version(app_handle: &AppHandle) -> Option<String> {
    let binary = active_dsh_binary(app_handle);
    dsh_engine_version_from_binary(&binary)
}

/// 桌面端选择记录中的活动核心版本（仅用于核心列表/旧兼容逻辑）。
pub fn active_version(app_handle: &AppHandle) -> Option<String> {
    match active_source(app_handle) {
        CoreSource::Local => local_core(app_handle).map(|c| c.version),
        CoreSource::App => config::get_dsh_pkg_tag(app_handle)
            .as_deref()
            .and_then(parse_version_from_tag)
            .or_else(|| config::get_dsh_version(app_handle)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsh_engine_version_reads_core_manifest() {
        let root = std::env::temp_dir().join(format!(
            "dsh-core-engine-version-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos()
        ));
        let package_dir = root.join("node_modules").join("@deepseek-ai").join("dsh");
        let binary = package_dir.join("lib").join("bin.js");
        std::fs::create_dir_all(binary.parent().expect("binary parent")).expect("create core");
        std::fs::write(
            package_dir.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.2"}"#,
        )
        .expect("write core manifest");

        assert_eq!(
            dsh_engine_version_from_binary(&binary).as_deref(),
            Some("0.1.5-rc.2")
        );
        std::fs::remove_dir_all(root).expect("remove core test directory");
    }

    #[test]
    fn core_source_round_trips() {
        assert_eq!(CoreSource::parse("local"), Some(CoreSource::Local));
        assert_eq!(CoreSource::parse("app"), Some(CoreSource::App));
        assert_eq!(CoreSource::parse("other"), None);
        assert_eq!(CoreSource::Local.as_str(), "local");
        assert_eq!(CoreSource::App.as_str(), "app");
    }
}
