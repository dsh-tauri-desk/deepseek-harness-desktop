//! 已安装插件监控：轮询 profile 插件文件（`package.json` + `node_modules` 下
//! 各直接依赖清单），内容变化时解析为结构化列表并通过 `dsh-plugins-updated`
//! 事件实时推送给前端（`use-dsh-plugins` hook 消费）。
//!
//! 采用与主题轮询（`config/theme.rs`）一致的「秒级 tick + 指纹比对」方案，
//! 不引入 notify 等文件监听依赖：插件数量少（个位数到十几个），每次读取的
//! 都是小 JSON 文件，开销可忽略；pnpm add/remove/install 期间的连续写盘由
//! 2s 防抖合并，避免事件风暴。
//!
//! 模块划分参考 [`super::installed`]（预装插件检测）：installed 聚焦预设清单
//! 的勾选态，这里解析「实际已安装」的插件元信息（名称/版本/描述/仓库地址/
//! 是否启动加载），供前端做已安装列表展示与后续插件管理。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::installed::{is_protected_bundle, profile_dir, ProfilePackageJson};
use super::preset::{load_presets, PreinstallPluginInfo};

/// 前端监听的事件名（插件列表变化时推送）
pub(crate) const PLUGINS_UPDATED_EVENT: &str = "dsh-plugins-updated";

/// 防抖窗口：pnpm 安装/卸载会在数秒内连续写盘，窗口内只保留最新指纹，
/// 避免每个 tick 都推送一次中间态
const DEBOUNCE: Duration = Duration::from_secs(2);

/// 已安装插件（序列化为 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPlugin {
    /// 依赖键（npm 包名），前端主键
    pub id: String,
    /// 展示名：插件 package.json 的 name，缺失时回落预设清单/依赖键
    pub name: String,
    /// 已安装版本（解析失败时为空字符串）
    pub version: String,
    pub description: String,
    /// 仓库地址（repository.url / homepage），缺失时回落预设清单
    pub repo_url: String,
    /// 是否在 `dsh.profile.bundles` 中（启动时自动加载）
    pub bundled: bool,
    /// 是否允许从启动冲突恢复流程移除（核心 Bundle 为 false）
    pub removable: bool,
    /// 预设清单中的「推荐」标记（绿色 chip）
    pub recommended: bool,
    /// 预设清单中的「修复」标记（黄色 chip）
    pub fix: bool,
}

/// 用于强类型解析插件自身 package.json 的辅助结构
#[derive(Deserialize, Default)]
struct PluginPackageJson {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<RepositoryField>,
}

/// repository 字段兼容两种形态：字符串 URL 或 `{ "type": "git", "url": ... }` 对象
#[derive(Deserialize)]
#[serde(untagged)]
enum RepositoryField {
    Url(String),
    Object { url: Option<String> },
}

/// 插件在 node_modules 下的目录：`node_modules/<id>`（scoped 包 id 形如
/// `@scope/pkg`，join 会按分隔符展开成 `node_modules/@scope/pkg`）
fn plugin_dir(profile: &Path, id: &str) -> PathBuf {
    profile.join("node_modules").join(id)
}

/// 规范化仓库地址，便于系统浏览器直接打开：
/// `git+https://...` / `git://...` → `https://...`，去掉末尾 `.git`
fn normalize_repo_url(url: &str) -> String {
    let mut normalized = url.trim().to_string();
    if let Some(rest) = normalized.strip_prefix("git+") {
        normalized = rest.to_string();
    }
    if let Some(rest) = normalized.strip_prefix("git://") {
        normalized = format!("https://{rest}");
    }
    if let Some(rest) = normalized.strip_suffix(".git") {
        normalized = rest.to_string();
    }
    normalized
}

/// 读取并解析插件自身的 package.json；缺失/损坏时返回 None（不阻断整体解析）
fn read_plugin_meta(dir: &Path) -> Option<PluginPackageJson> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    serde_json::from_str(&content).ok()
}

/// 解析 profile 目录下实际已安装的插件列表（纯函数，便于单元测试）。
///
/// 只列出 profile package.json `dependencies` 中的直接依赖——node_modules 里
/// 还有大量传递依赖（clsx/zod 等），它们不是用户安装的 dsh 插件，不应展示。
fn parse_plugins(profile: &Path, presets: &[PreinstallPluginInfo]) -> Vec<DshPlugin> {
    let manifest_content = match std::fs::read_to_string(profile.join("package.json")) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    let manifest: ProfilePackageJson = match serde_json::from_str(&manifest_content) {
        Ok(manifest) => manifest,
        Err(_) => return Vec::new(),
    };

    let bundled: HashSet<&str> = manifest
        .dsh
        .as_ref()
        .and_then(|dsh| dsh.profile.as_ref())
        .map(|profile| profile.bundles.iter().map(String::as_str).collect())
        .unwrap_or_default();

    let preset_map: HashMap<&str, &PreinstallPluginInfo> =
        presets.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut dep_ids: Vec<&String> = manifest.dependencies.keys().collect();
    // 稳定排序：启动加载（bundles）的插件在前，其余按 id 字典序
    dep_ids.sort_by_key(|id| (!bundled.contains(id.as_str()), id.as_str()));

    dep_ids
        .into_iter()
        .filter_map(|id| {
            let preset = preset_map.get(id.as_str());
            let meta = read_plugin_meta(&plugin_dir(profile, id));
            let repo_url = meta
                .as_ref()
                .and_then(|m| match &m.repository {
                    Some(RepositoryField::Url(url)) => Some(url.clone()),
                    Some(RepositoryField::Object { url }) => url.clone(),
                    None => m.homepage.clone(),
                })
                .or_else(|| preset.map(|p| p.repo_url.clone()))
                .map(|url| normalize_repo_url(&url))
                .unwrap_or_default();
            Some(DshPlugin {
                id: id.clone(),
                name: meta
                    .as_ref()
                    .and_then(|m| m.name.clone())
                    .or_else(|| preset.map(|p| p.name.clone()))
                    .unwrap_or_else(|| id.clone()),
                version: meta
                    .as_ref()
                    .and_then(|m| m.version.clone())
                    .unwrap_or_default(),
                description: meta
                    .as_ref()
                    .and_then(|m| m.description.clone())
                    .or_else(|| preset.map(|p| p.description.clone()))
                    .unwrap_or_default(),
                repo_url,
                bundled: bundled.contains(id.as_str()),
                removable: !is_protected_bundle(id.as_str()),
                recommended: preset.map(|p| p.recommended).unwrap_or(false),
                fix: preset.map(|p| p.fix).unwrap_or(false),
            })
        })
        .collect()
}

/// 已安装插件列表（含解析后的元信息），前端首次加载/手动刷新用
pub fn list(app_handle: &AppHandle) -> Vec<DshPlugin> {
    let presets = load_presets(app_handle);
    parse_plugins(&profile_dir(app_handle), &presets)
}

/// 变化指纹：profile package.json 与各直接依赖插件 package.json 的内容拼接。
///
/// pnpm add/remove/install 会重写 profile 清单（依赖与 bundles）并落盘插件包，
/// 任一变化都会改变指纹；profile 未初始化（首次运行）时返回 None。
fn fingerprint(app_handle: &AppHandle) -> Option<String> {
    let dir = profile_dir(app_handle);
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let parsed = serde_json::from_str::<ProfilePackageJson>(&manifest).ok()?;
    let mut dep_ids: Vec<&String> = parsed.dependencies.keys().collect();
    dep_ids.sort();

    let mut parts = vec![manifest];
    for id in dep_ids {
        if let Ok(content) = std::fs::read_to_string(plugin_dir(&dir, id).join("package.json")) {
            parts.push(content);
        }
    }
    Some(parts.join("\n---\n"))
}

/// 监控状态：指纹 + 防抖窗口（仅 check_and_emit 单线程轮询访问）
struct WatchState {
    /// 上次已推送的指纹（内容一致则跳过）
    last_fp: Option<String>,
    /// 上次推送时间（用于防抖合并）
    last_emit: Option<Instant>,
    /// 防抖窗口内待推送的最新指纹
    pending_fp: Option<String>,
}

static STATE: OnceLock<Mutex<WatchState>> = OnceLock::new();

/// 秒级轮询入口（由 scheduler 永久循环调用）：指纹变化且超过防抖窗口时，
/// 重新解析插件列表并推送 `dsh-plugins-updated` 事件。
pub fn check_and_emit(app_handle: &AppHandle) {
    let fp = fingerprint(app_handle);
    let mut state = STATE
        .get_or_init(|| {
            Mutex::new(WatchState {
                last_fp: None,
                last_emit: None,
                pending_fp: None,
            })
        })
        .lock()
        .unwrap();

    if state.last_fp.as_deref() == fp.as_deref() {
        return;
    }
    // 指纹变化：先记下待推送值，再判断是否已过防抖窗口（安装过程中连续
    // 变化时合并为一次推送，窗口结束前的变化会在后续 tick 补推）
    state.pending_fp = fp;
    let can_emit = state
        .last_emit
        .map_or(true, |last| last.elapsed() >= DEBOUNCE);
    if !can_emit {
        return;
    }
    state.last_emit = Some(Instant::now());
    state.last_fp = state.pending_fp.take();
    emit(app_handle);
}

/// 解析并推送插件列表；profile 被移除（指纹为 None）时推送空列表让前端清空
fn emit(app_handle: &AppHandle) {
    let plugins = list(app_handle);
    log::debug!(
        "dsh plugins changed, emitting {} plugin(s) to frontend",
        plugins.len()
    );
    let _ = app_handle.emit(PLUGINS_UPDATED_EVENT, &plugins);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时 profile：package.json + node_modules 下的插件包清单
    /// （tag 用于区分不同测试的临时目录，避免并行执行时互相清理）
    fn build_profile(tag: &str, packages: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-watch-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir.join("node_modules")).unwrap();
        let mut manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": [] } }
        });
        let mut deps = serde_json::Map::new();
        let mut bundles = Vec::new();
        for (id, meta_json) in packages {
            deps.insert((*id).to_string(), serde_json::Value::String("1.0.0".into()));
            let pkg_dir = dir.join("node_modules").join(id);
            std::fs::create_dir_all(&pkg_dir).unwrap();
            std::fs::write(pkg_dir.join("package.json"), *meta_json).unwrap();
            if meta_json.contains("\"dsh\"") {
                bundles.push((*id).to_string());
            }
        }
        manifest["dependencies"] = serde_json::Value::Object(deps);
        manifest["dsh"]["profile"]["bundles"] = serde_json::Value::Array(
            bundles.into_iter().map(serde_json::Value::String).collect(),
        );
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn presets_for_test() -> Vec<PreinstallPluginInfo> {
        vec![PreinstallPluginInfo {
            id: "dshmarket".into(),
            spec: "dshmarket".into(),
            name: "DSH Market".into(),
            description: "Visual plugin market".into(),
            repo_url: "https://github.com/dsh-market/dsh-market".into(),
            recommended: true,
            fix: false,
            default_checked: false,
            win_only: false,
            package: None,
        }]
    }

    #[test]
    fn parse_plugins_lists_direct_deps_with_meta() {
        let dir = build_profile(
            "meta",
            &[
                (
                    "dshmarket",
                    r#"{"name":"dshmarket","version":"1.13.1","description":"market","repository":{"type":"git","url":"git+https://github.com/dsh-market/dsh-market.git"},"dsh":{"bundle":{}}}"#,
                ),
                (
                    "@anionex/dsh-turn-rewind",
                    r#"{"name":"@anionex/dsh-turn-rewind","version":"0.1.1","description":"rewind"}"#,
                ),
            ],
        );
        let plugins = parse_plugins(&dir, &presets_for_test());
        assert_eq!(plugins.len(), 2);

        let market = plugins.iter().find(|p| p.id == "dshmarket").unwrap();
        assert!(market.bundled);
        assert!(market.recommended);
        assert_eq!(market.version, "1.13.1");
        assert_eq!(market.repo_url, "https://github.com/dsh-market/dsh-market");

        let rewind = plugins
            .iter()
            .find(|p| p.id == "@anionex/dsh-turn-rewind")
            .unwrap();
        assert!(!rewind.bundled);
        assert!(!rewind.recommended);
        assert_eq!(rewind.name, "@anionex/dsh-turn-rewind");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_plugins_falls_back_to_preset_and_sorts_bundled_first() {
        let dir = build_profile(
            "fallback",
            &[
                (
                    "dsh-at-file",
                    r#"{"name":"dsh-at-file"}"#,
                ),
                (
                    "dshmarket",
                    r#"{"name":"dshmarket","dsh":{"bundle":{}}}"#,
                ),
            ],
        );
        let plugins = parse_plugins(&dir, &presets_for_test());
        // bundled（dshmarket）在前
        assert_eq!(plugins[0].id, "dshmarket");
        // 无版本/描述时回落预设清单
        let market = &plugins[0];
        assert_eq!(market.version, "");
        assert_eq!(market.description, "Visual plugin market");
        assert_eq!(market.repo_url, "https://github.com/dsh-market/dsh-market");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_plugins_returns_empty_without_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-watch-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(parse_plugins(&dir, &[]).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
