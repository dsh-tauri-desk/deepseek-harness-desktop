//! bridge/preset_pet.rs — 预设宠物清单（`resources/preset-pets.json`）。
//!
//! 预设宠物不再下载到本地：清单里的条目本身就是 `dsh-pet-component` 的
//! `<Pet>` 渲染参数（`config` / `uri` / `ext` / `kind` / `size`），pet 窗口按
//! 当前激活 id 取到条目后直连远端素材播放（macOS 用 `uri.mac` / `ext.mac`
//! 指向 HEVC-with-Alpha 的 `.mov` 素材：WKWebView 不认 VP9-alpha WebM）。
//!
//! 于是本模块只剩两件事，全部与「下载/解压/安装」无关：
//! 1. 定位并读取随安装包分发的清单；
//! 2. 校验形状（id 安全 + 唯一、地址非空、kind 合法）后原样交给前端。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 预设宠物清单文件名（随安装包分发，见 `tauri.conf.json` 的 bundle.resources）。
const PRESET_PETS_FILE: &str = "preset-pets.json";

/// 清单条目（`resources/preset-pets.json` 的一个元素）。
///
/// 字段名与 `dsh-pet-component` 的 props 一一对应，前端拿到后直接展开给 `<Pet>`；
/// `deny_unknown_fields` 保证清单写错字段（如 `sizeMB`）立即报错，而不是被静默忽略。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetSpec {
    /// 唯一标识（`active_pet` 持久化的就是它）。
    pub id: String,
    /// 设置页展示名。
    pub name: String,
    /// 设置页展示描述。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// 设置页卡片预览图（远端 URL，主窗口 CSP 需允许该图源）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// 渲染器协议：`dsh`（逐动作透明视频）/ `codex`（单张雪碧图集）；缺省由组件自动判定。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 渲染宽度 px（高度由协议画布比例推算）；缺省取组件默认值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    /// 配置文件地址（dsh-pet `config.jsonc` 或 Codex `pet.json`）。
    pub config: String,
    /// 素材地址（dsh-pet 用 `{ default, mac }`：macOS 换 HEVC-alpha 素材）。
    pub uri: PresetPetUri,
    /// 素材后缀；缺省 `{ default: "webm", mac: "mov" }`（Codex 渲染器忽略）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<PresetPetExt>,
}

/// 素材基地址：`default` 必填，`mac` 覆盖 Apple 平台（WKWebView 不认 VP9-alpha）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetUri {
    pub default: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
}

/// 素材后缀：`default` 必填，`mac` 覆盖 Apple 平台。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetPetExt {
    pub default: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
}

/// 预设 id 是否安全（直接进入设置持久化与命令参数，只允许 ASCII 字母数字与 `-`/`_`）。
pub(crate) fn safe_preset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

/// 定位清单文件：优先随安装包分发的资源目录，回落源码 `resources/`。
fn preset_pets_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for candidate in [
            dir.join(PRESET_PETS_FILE),
            dir.join("resources").join(PRESET_PETS_FILE),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(PRESET_PETS_FILE);
    source.exists().then_some(source)
}

/// 读取并校验清单。任何形状问题都返回带 `PET_PRESET_CATALOG_*` 前缀的错误，不做静默兜底。
pub fn read_preset_catalog(app: &AppHandle) -> Result<Vec<PresetPetSpec>, String> {
    let path = preset_pets_path(app)
        .ok_or_else(|| "PET_PRESET_CATALOG_MISSING: preset-pets.json was not found".to_string())?;
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "PET_PRESET_CATALOG_READ_FAILED: failed to read {}: {error}",
            path.display()
        )
    })?;
    let catalog: Vec<PresetPetSpec> = serde_json::from_slice(&bytes).map_err(|error| {
        format!("PET_PRESET_CATALOG_INVALID: invalid preset-pets.json: {error}")
    })?;
    let mut ids = HashSet::new();
    for spec in &catalog {
        if !safe_preset_id(&spec.id) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset id {:?} is not a safe id",
                spec.id
            ));
        }
        if !ids.insert(spec.id.as_str()) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: duplicate preset id {:?}",
                spec.id
            ));
        }
        if spec.name.trim().is_empty() {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset {:?} must have a non-empty name",
                spec.id
            ));
        }
        if spec.config.trim().is_empty() {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset {:?} must have a non-empty config",
                spec.id
            ));
        }
        if spec.uri.default.trim().is_empty() {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset {:?} must have a non-empty uri.default",
                spec.id
            ));
        }
        if let Some(kind) = spec.kind.as_deref() {
            if kind != "dsh" && kind != "codex" {
                return Err(format!(
                    "PET_PRESET_CATALOG_INVALID: preset {:?} kind must be dsh or codex",
                    spec.id
                ));
            }
        }
    }
    Ok(catalog)
}

/// 列出预设宠物清单（前端按当前激活 id 自行取用；条目即 `<Pet>` 的渲染参数）。
#[tauri::command]
pub fn list_preset_pets(app: AppHandle) -> Result<Vec<PresetPetSpec>, String> {
    read_preset_catalog(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped_catalog() -> Vec<PresetPetSpec> {
        let bytes = fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/preset-pets.json"
        ))
        .unwrap();
        let catalog: Vec<PresetPetSpec> = serde_json::from_slice(&bytes).unwrap();
        assert!(!catalog.is_empty(), "预设清单不应为空");
        catalog
    }

    #[test]
    fn shipped_catalog_is_valid_and_remote_only() {
        // 随包分发的清单是唯一事实来源：字段名/形状写错必须在这里炸，
        // 而不是等用户点「启用」才在运行时静默失败。
        for spec in shipped_catalog() {
            assert!(safe_preset_id(&spec.id), "非法 id: {}", spec.id);
            assert!(!spec.name.trim().is_empty());
            assert!(!spec.config.trim().is_empty());
            assert!(!spec.uri.default.trim().is_empty());
            // 不再有本地安装：素材与配置都必须是远端地址。
            assert!(
                spec.config.starts_with("https://"),
                "config 必须是 https 地址"
            );
            assert!(
                spec.uri.default.starts_with("https://"),
                "uri.default 必须是 https 地址"
            );
            if let Some(kind) = spec.kind.as_deref() {
                assert!(kind == "dsh" || kind == "codex");
            }
        }
    }

    #[test]
    fn shipped_catalog_provides_macos_mov_override() {
        // macOS 的 WKWebView 不认 VP9-alpha：至少一个预设必须给出 .mov 覆盖块。
        let spec = shipped_catalog()
            .into_iter()
            .find(|spec| spec.uri.mac.is_some())
            .expect("至少一个预设应提供 macOS 素材覆盖");
        let mac = spec.uri.mac.unwrap();
        assert!(mac.starts_with("https://"));
        assert!(mac.ends_with("/mov"), "macOS 素材目录应为 mov/: {mac}");
        assert_eq!(
            spec.ext.as_ref().and_then(|ext| ext.mac.as_deref()),
            Some("mov")
        );
    }

    #[test]
    fn catalog_entry_deserializes_with_defaults_and_rejects_unknown_fields() {
        let spec: PresetPetSpec = serde_json::from_str(
            r#"{
                "id": "maid-deepseek-whale",
                "name": "Maid DeepSeek Whale",
                "config": "https://example.com/config.jsonc",
                "uri": { "default": "https://example.com/webm" }
            }"#,
        )
        .unwrap();
        assert_eq!(spec.id, "maid-deepseek-whale");
        assert_eq!(spec.desc, None);
        assert_eq!(spec.kind, None);
        assert_eq!(spec.size, None);
        assert_eq!(spec.ext, None);
        assert_eq!(spec.uri.mac, None);

        // 字段名写错（如旧的 sizeMb）必须立刻报错，而不是被静默忽略。
        let error = serde_json::from_str::<PresetPetSpec>(
            r#"{
                "id": "x",
                "name": "X",
                "config": "https://example.com/config.jsonc",
                "uri": { "default": "https://example.com/webm" },
                "sizeMb": 113
            }"#,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("sizeMb"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn serialization_omits_absent_optional_fields() {
        // 前端 props 里 optional 字段缺省即 undefined：null 会让 `mac?: string` 变成 null。
        let spec = PresetPetSpec {
            id: "p".to_string(),
            name: "P".to_string(),
            desc: None,
            image: None,
            kind: Some("dsh".to_string()),
            size: Some(220.0),
            config: "https://example.com/config.jsonc".to_string(),
            uri: PresetPetUri {
                default: "https://example.com/webm".to_string(),
                mac: None,
            },
            ext: None,
        };
        let value = serde_json::to_value(&spec).unwrap();
        assert!(value.get("desc").is_none());
        assert!(value.get("ext").is_none());
        assert!(value["uri"].get("mac").is_none());
        assert_eq!(value["kind"], "dsh");
        assert_eq!(value["size"], 220.0);
    }

    #[test]
    fn catalog_validation_rejects_unsafe_ids_and_bad_kind() {
        let bad_id = r#"[{ "id": "../escape", "name": "X", "config": "https://e.com/c.jsonc", "uri": { "default": "https://e.com/w" } }]"#;
        let catalog: Vec<PresetPetSpec> = serde_json::from_str(bad_id).unwrap();
        assert!(!safe_preset_id(&catalog[0].id));

        let bad_kind = r#"[{ "id": "x", "name": "X", "kind": "sprite", "config": "https://e.com/c.jsonc", "uri": { "default": "https://e.com/w" } }]"#;
        let catalog: Vec<PresetPetSpec> = serde_json::from_str(bad_kind).unwrap();
        assert_eq!(catalog[0].kind.as_deref(), Some("sprite"));
        assert!(catalog[0]
            .kind
            .as_deref()
            .is_some_and(|kind| kind != "dsh" && kind != "codex"));
    }
}
