//! 已安装插件检测：强类型解析 profile 下 package.json 的 `dependencies` 键与
//! `dsh.profile.bundles` 列表，得到已安装插件 id 集合，并组装前端渲染列表。

use crate::config;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::AppHandle;

use super::preset::{load_presets, PreinstallPluginInfo};

/// 预装插件安装到的 profile（与 dsh 服务启动的 profile 一致）
pub(crate) const PREINSTALL_PROFILE: &str = "web";
/// 桌面端运行所依赖的核心 Bundle，不允许通过冲突恢复移除。
pub(crate) fn is_protected_bundle(id: &str) -> bool {
    matches!(
        id,
        "@deepseek-ai/dsh-base"
            | "@deepseek-ai/dsh-web-app"
            | "@deepseek-ai/dsh-headless"
    )
}

/// 用于强类型解析 profile 下 package.json 的辅助结构
/// （字段 pub(crate)：供 watch 模块解析已安装插件清单复用）
#[derive(Deserialize)]
pub(crate) struct ProfilePackageJson {
    #[serde(default)]
    pub(crate) dependencies: HashMap<String, String>,
    #[serde(default)]
    pub(crate) dsh: Option<ProfileDshSection>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileDshSection {
    #[serde(default)]
    pub(crate) profile: Option<ProfileInner>,
}

#[derive(Deserialize)]
pub(crate) struct ProfileInner {
    #[serde(default)]
    pub(crate) bundles: Vec<String>,
}

/// 预装插件所在的 profile 目录（$DSH_HOME/profiles/web）
pub(crate) fn profile_dir(app_handle: &AppHandle) -> PathBuf {
    config::get_dsh_data_path(app_handle)
        .join("profiles")
        .join(PREINSTALL_PROFILE)
}

/// 已安装的插件 id 集合：通过强类型反序列化读取 package.json 的 `dependencies` 键与 `bundles` 列表
fn list_installed(app_handle: &AppHandle) -> HashSet<String> {
    let manifest_path = profile_dir(app_handle).join("package.json");
    let Ok(content) = std::fs::read_to_string(&manifest_path) else {
        return HashSet::new();
    };

    let Ok(manifest) = serde_json::from_str::<ProfilePackageJson>(&content) else {
        return HashSet::new();
    };

    let mut set: HashSet<String> = manifest.dependencies.into_keys().collect();
    if let Some(dsh) = manifest.dsh {
        if let Some(profile) = dsh.profile {
            set.extend(profile.bundles);
        }
    }
    set
}

/// 预装插件列表项（含已安装检测结果），序列化给前端
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repo_url: String,
    pub recommended: bool,
    /// 是否为「修复」类项（前端渲染黄色 chip，默认勾选）
    pub fix: bool,
    /// 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」）
    pub default_checked: bool,
    pub installed: bool,
}

/// 用于“已安装”检测的包名：预设显式声明 `package` 时用它（scoped 包名与预设
/// id 不一致），未声明则回落到 `id`。
fn installed_name(p: &PreinstallPluginInfo) -> &str {
    p.package.as_deref().unwrap_or(p.id.as_str())
}

/// 预装插件列表（含 installed 状态），前端渲染用
pub fn list(app_handle: &AppHandle) -> Vec<PreinstallPlugin> {
    let installed = list_installed(app_handle);
    let is_windows = cfg!(windows);

    load_presets(app_handle)
        .into_iter()
        .filter(|p| !p.win_only || is_windows)
        .map(|p| {
            // 已安装检测以实际 npm 包名为准：预设可显式声明 package（scoped 包
            // 名与预设 id 不一致时），未声明则回落到 id。
            let is_installed = installed.contains(installed_name(&p));
            PreinstallPlugin {
                id: p.id,
                name: p.name,
                description: p.description,
                repo_url: p.repo_url,
                recommended: p.recommended,
                fix: p.fix,
                default_checked: p.default_checked,
                installed: is_installed,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_installed_parses_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-plugin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest_json = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {
                "dshmarket": "1.0.0",
                "@deepseek-ai/dsh-base": "1.0.0"
            },
            "dsh": {
                "profile": {
                    "bundles": ["@deepseek-ai/dsh-base", "dshmarket"]
                }
            }
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string(&manifest_json).unwrap(),
        )
        .unwrap();

        let content = std::fs::read_to_string(dir.join("package.json")).unwrap();
        let parsed: ProfilePackageJson = serde_json::from_str(&content).unwrap();

        let mut set: HashSet<String> = parsed.dependencies.into_keys().collect();
        if let Some(dsh) = parsed.dsh {
            if let Some(profile) = dsh.profile {
                set.extend(profile.bundles);
            }
        }

        assert!(set.contains("dshmarket"));
        assert!(set.contains("@deepseek-ai/dsh-base"));
        assert_eq!(set.len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn installed_name_resolves_package_else_id() {
        let installed = PreinstallPluginInfo {
            id: "dsh-session-context-menu".into(),
            spec: "github:baihejiangnan/dsh-session-context-menu".into(),
            package: Some("@baihejiangnan/dsh-session-context-menu".into()),
            name: "DSH Session Context Menu".into(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: true,
            win_only: false,
        };
        // scoped 包名与预设 id 不同：以 package 为准
        assert_eq!(
            installed_name(&installed),
            "@baihejiangnan/dsh-session-context-menu"
        );

        // 未声明 package 时回落到 id
        let plain = PreinstallPluginInfo { package: None, ..installed };
        assert_eq!(installed_name(&plain), "dsh-session-context-menu");
    }
}