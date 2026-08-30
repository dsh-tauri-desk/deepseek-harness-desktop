//! 档案管理。
//!
//! 档案 = `$DSH_HOME/profiles/<id>` 目录，与官方 dsh CLI 的 profile 语义一致
//! （`dsh --profile <id>` 启动 / `dsh plugin --profile <id>` 管理插件）。
//! 桌面端把「当前使用哪个档案」持久化在自己的 store 设置（`active_profile`，
//! 默认 `web`），服务启动、插件安装/升级/卸载全部以它为准——不再写死 web。
//!
//! 新建档案时按官方 `dsh-app-boot` 的 `initProfile` 形态初始化目录：
//! `package.json`（含 web 模板 bundles）+ `cordis.patch.yml` + `pnpm-workspace.yaml`，
//! 与 CLI 侧产物完全一致，两边可互相操作。

use crate::config;
use crate::service::fs_guard;
use serde::Serialize;
use serde_yaml::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

/// 档案备份（ZIP）深模块：列出、创建、还原、读取/保存设置与自动备份调度。
pub mod backup;

pub use backup::{ProfileBackup, RestoreResult};

/// 桌面端默认档案（内置，不可删除）
pub const DEFAULT_PROFILE: &str = "web";

/// 依赖重建标记文件名：克隆/还原后写入档案目录，下次启动按 manifest/lockfile
/// 执行 `pnpm install` 重建所有直接依赖（不复制 `node_modules`）。
pub(crate) const REBUILD_MARKER: &str = ".dsh-rebuild-deps";

/// 备份/克隆排除的依赖目录（相对档案根，任意层级命中即排除）
const EXCLUDED_DEP_DIRS: [&str; 2] = ["node_modules", ".pnpm-store"];

/// 相对路径是否应排除在备份/克隆之外：依赖目录（路径首层命中即排除；深层由
/// 递归调用方逐层判断）、临时标记文件与常见临时文件（编辑器交换文件、缓存
/// 缩略图等）。
pub(crate) fn is_excluded_from_backup(rel: &Path) -> bool {
    if let Some(Component::Normal(first)) = rel.components().next() {
        if EXCLUDED_DEP_DIRS.contains(&first.to_str().unwrap_or_default()) {
            return true;
        }
    }
    let name = rel.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if name == REBUILD_MARKER || name == ".DS_Store" || name == "Thumbs.db" {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".tmp") || lower.ends_with(".temp") || name.ends_with('~')
}

/// 新建档案的初始 bundles：web 模板（`@deepseek-ai/dsh-base` +
/// `@deepseek-ai/dsh-web-app`，与 dsh-app-boot `PROFILE_TEMPLATES.web` 一致）。
/// 桌面端内嵌的是 dsh web 应用，新档案不带 `dsh-web-app` 将无法渲染任何界面。
const WEB_PROFILE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// dsh `initProfile` 生成的空 patch 层（与官方一致）
const PROFILE_PATCH_TEMPLATE: &str = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n";

/// dsh `initProfile` 生成的 pnpm 设置（与官方一致）
const PROFILE_PNPM_WORKSPACE: &str =
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\n# The desktop runtime intentionally reviews this fresh transitive release.\nminimumReleaseAgeExclude:\n  - zod@4.4.3\n";

/// 档案行（序列化 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// 档案 id（目录名，npm 包名语义）
    pub id: String,
    /// 展示名（manifest.name 去 `dsh-profile-` 前缀，缺失回落 id）
    pub name: String,
    /// 描述（manifest.description；克隆自动写入「克隆自 <源>」）
    pub description: String,
    /// 是否桌面端内置默认档案（web）
    pub default: bool,
    /// 是否当前使用中的档案
    pub active: bool,
}

/// 指定档案的目录（`$DSH_HOME/profiles/<id>`）
pub fn profile_dir_of(app_handle: &AppHandle, id: &str) -> PathBuf {
    config::get_dsh_data_path(app_handle)
        .join("profiles")
        .join(id)
}

/// pnpm 11 的最小发布时间策略会在 registry 元数据短暂不可用时把已审查的
/// lockfile 条目误判为违规。zod 是当前 Harness runtime closure 中的已审查条目，
/// 仅豁免 lockfile 使用的精确版本，避免关闭整个 supply-chain policy。
const PROFILE_MINIMUM_RELEASE_AGE_EXCLUDES: [&str; 1] = ["zod@4.4.3"];

pub(crate) fn ensure_profile_pnpm_policy(app_handle: &AppHandle) -> Result<(), String> {
    let path = profile_dir_of(app_handle, &active_profile(app_handle)).join("pnpm-workspace.yaml");
    let existing = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            PROFILE_PNPM_WORKSPACE.to_string()
        }
        Err(error) => return Err(format!("PROFILE_WORKSPACE_READ: {error}")),
    };
    let mut document: Value = serde_yaml::from_str(&existing)
        .map_err(|e| format!("PROFILE_WORKSPACE_INVALID_YAML: {e}"))?;
    let mapping = document.as_mapping_mut().ok_or_else(|| {
        "PROFILE_WORKSPACE_NOT_MAP: pnpm-workspace.yaml must be a mapping".to_string()
    })?;
    let key = Value::String("minimumReleaseAgeExclude".to_string());
    let excludes = mapping
        .entry(key)
        .or_insert_with(|| Value::Sequence(Vec::new()));
    let sequence = excludes.as_sequence_mut().ok_or_else(|| {
        "PROFILE_WORKSPACE_POLICY_INVALID: minimumReleaseAgeExclude must be a sequence".to_string()
    })?;
    let mut changed = false;
    for package in PROFILE_MINIMUM_RELEASE_AGE_EXCLUDES {
        let value = Value::String(package.to_string());
        if !sequence.iter().any(|item| item == &value) {
            sequence.push(value);
            changed = true;
        }
    }
    if changed {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("PROFILE_WORKSPACE_MKDIR: {e}"))?;
        }
        let rendered = serde_yaml::to_string(&document)
            .map_err(|e| format!("PROFILE_WORKSPACE_RENDER: {e}"))?;
        fs::write(&path, rendered).map_err(|e| format!("PROFILE_WORKSPACE_WRITE: {e}"))?;
        log::info!(
            "Ensured profile pnpm release-age policy: {}",
            path.display()
        );
    }
    Ok(())
}

/// 当前使用的档案 id。
///
/// 读取桌面端持久化的 `active_profile`；若记录的档案目录已不存在（被删除/外部
/// 清理），回退默认 web。全新机器上 `profiles/` 尚未初始化时同样回退 web
/// （web 由 dsh 启动/插件操作时按需初始化）。
pub fn active_profile(app_handle: &AppHandle) -> String {
    let stored = config::get_store_dat_setting(app_handle).active_profile;
    if !stored.is_empty()
        && stored != DEFAULT_PROFILE
        && profile_dir_of(app_handle, &stored).is_dir()
    {
        stored
    } else {
        DEFAULT_PROFILE.to_string()
    }
}

/// 读取档案 manifest 的展示名：`dsh-profile-<id>` → `<id>`（首字母大写）。
fn manifest_display_name(dir: &Path, id: &str) -> String {
    let raw = fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_default();
    let stripped = raw
        .strip_prefix("dsh-profile-")
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| raw);
    let fallback = id.to_string();
    let name = if stripped.is_empty() {
        fallback
    } else {
        stripped
    };
    // 首字母大写，与既有「Web」展示风格一致
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => name,
    }
}

/// 读取档案 manifest 的 `description` 字段（缺失回落空串）。
fn manifest_description(dir: &Path) -> String {
    fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("description").and_then(|d| d.as_str()).map(String::from))
        .unwrap_or_default()
}

/// 档案描述（通知/还原结果等场景；目录缺失回落空串）。
pub fn description_of(app_handle: &AppHandle, id: &str) -> String {
    manifest_description(&profile_dir_of(app_handle, id))
}

/// 档案列表（含 active/default 标记）。web 未初始化（全新安装）时也展示默认档案。
pub fn list(app_handle: &AppHandle) -> Vec<Profile> {
    let active = active_profile(app_handle);
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    let mut out: Vec<Profile> = Vec::new();
    if let Ok(entries) = fs::read_dir(&profiles_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // 跳过隐藏/系统目录（如 node_modules 回退链接区、.dsh 内部目录）
            if id.starts_with('.') || id == "node_modules" {
                continue;
            }
            out.push(Profile {
                id: id.to_string(),
                name: manifest_display_name(&path, id),
                description: manifest_description(&path),
                default: id == DEFAULT_PROFILE,
                active: id == active,
            });
        }
    }
    if !out.iter().any(|p| p.id == DEFAULT_PROFILE) {
        out.push(Profile {
            id: DEFAULT_PROFILE.to_string(),
            name: "Web".to_string(),
            description: String::new(),
            default: true,
            active: active == DEFAULT_PROFILE,
        });
    }
    // 稳定排序：默认档案在前，其余按 id 字典序
    out.sort_by_key(|p| (!p.default, p.id.clone()));
    out
}

/// 把展示名规范为档案 id：小写、非字母数字转 `-`（连续分隔符合并）、去首尾 `-`。
fn normalize_profile_id(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_sep = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('-');
            }
            pending_sep = false;
            out.push(c);
        } else if c == ' ' || c == '-' || c == '_' {
            pending_sep = true;
        }
        // 其余字符（中文/符号）丢弃
    }
    out.trim_matches('-').to_string()
}

/// 新建档案：初始化 `$DSH_HOME/profiles/<id>`（manifest + patch + pnpm 设置）。
pub fn create(app_handle: &AppHandle, name: &str) -> Result<Profile, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("PROFILE_EMPTY_NAME: profile name is empty".to_string());
    }
    let id = normalize_profile_id(trimmed);
    if id.is_empty() {
        return Err("PROFILE_INVALID_NAME: profile name has no usable characters".to_string());
    }
    if id.len() > 64 {
        return Err("PROFILE_NAME_TOO_LONG: profile id exceeds 64 characters".to_string());
    }
    if id == DEFAULT_PROFILE {
        return Err("PROFILE_RESERVED: this name is reserved".to_string());
    }
    let dir = profile_dir_of(app_handle, &id);
    if dir.is_dir() {
        return Err(format!("PROFILE_EXISTS: profile {id} already exists"));
    }
    init_profile_dir(&dir, &id)?;
    Ok(Profile {
        id,
        name: trimmed.to_string(),
        description: String::new(),
        default: false,
        active: false,
    })
}

/// 切换当前使用中的档案（持久化到桌面端 store）。
pub fn set_active(app_handle: &AppHandle, id: &str) -> Result<Profile, String> {
    // 路径安全：拒绝 `..`、绝对路径、分隔符（防御式——id 理论上来自
    // normalize 产物，但 CLI/配置可能把任意字符串塞进设置），并用
    // fs_guard::join_safe 组装档案根目录下的目标路径。
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    let dir = fs_guard::join_safe(&profiles_root, id)?;
    if id != DEFAULT_PROFILE && !dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {id} does not exist"));
    }
    let mut setting = config::get_store_dat_setting(app_handle);
    setting.active_profile = id.to_string();
    config::set_store_dat_setting(app_handle, setting);
    list(app_handle)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "PROFILE_NOT_FOUND: profile disappeared after switch".to_string())
}

/// 删除档案（默认档案与使用中的档案不可删除；删除成功后连带清理该档案的备份）。
pub fn remove(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    if id == DEFAULT_PROFILE {
        return Err(
            "PROFILE_DEFAULT_NOT_REMOVABLE: the default profile cannot be removed".to_string(),
        );
    }
    if id == active_profile(app_handle) {
        return Err(
            "PROFILE_ACTIVE_NOT_REMOVABLE: the active profile cannot be removed".to_string(),
        );
    }
    // 路径安全：ID 字符集白名单 + 目标必须位于 profiles 根目录内（防 `..` 穿越）
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    let dir = fs_guard::safe_remove_target(&profiles_root, id)?;
    if !dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {id} does not exist"));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("PROFILE_REMOVE_FAILED: {e}"))?;
    // 档案已删除：连带清理它的备份目录（$DSH_HOME/backups/profiles/<id>）。
    // 最佳努力——备份清理失败只告警，不影响档案删除结果。
    let backups_root = config::get_dsh_data_path(app_handle).join("backups").join("profiles");
    if let Ok(backup_dir) = fs_guard::join_safe(&backups_root, id) {
        if backup_dir.is_dir() {
            if let Err(e) = fs::remove_dir_all(&backup_dir) {
                log::warn!(
                    "failed to remove backups of deleted profile {id}: {}: {e}",
                    backup_dir.display()
                );
            } else {
                log::info!("removed backups of deleted profile {id}: {}", backup_dir.display());
            }
        }
    }
    Ok(())
}

/// 初始化档案目录：与官方 `dsh-app-boot::initProfile` 的产物一致
/// （web 模板 bundles；已有文件绝不覆盖，重跑为 no-op）。
fn init_profile_dir(dir: &Path, id: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("PROFILE_MKDIR: {e}"))?;

    let manifest_path = dir.join("package.json");
    if !manifest_path.exists() {
        let manifest = serde_json::json!({
            "name": format!("dsh-profile-{id}"),
            "private": true,
            "dependencies": {},
            "dsh": { "profile": { "bundles": WEB_PROFILE_BUNDLES } }
        });
        let content = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("PROFILE_MANIFEST_RENDER: {e}"))?;
        fs::write(&manifest_path, format!("{content}\n"))
            .map_err(|e| format!("PROFILE_MANIFEST_WRITE: {e}"))?;
    }

    let patch_path = dir.join("cordis.patch.yml");
    if !patch_path.exists() {
        fs::write(&patch_path, PROFILE_PATCH_TEMPLATE)
            .map_err(|e| format!("PROFILE_PATCH_WRITE: {e}"))?;
    }

    let workspace_path = dir.join("pnpm-workspace.yaml");
    if !workspace_path.exists() {
        fs::write(&workspace_path, PROFILE_PNPM_WORKSPACE)
            .map_err(|e| format!("PROFILE_WORKSPACE_WRITE: {e}"))?;
    }

    // pnpm 无 TTY 环境重装/更新会触发交互确认（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），
    // 与 ensure_profile_npmrc 一致地预写 .npmrc（幂等，绝不覆盖已有配置）。
    let npmrc_path = dir.join(".npmrc");
    let npmrc_existing = fs::read_to_string(&npmrc_path).unwrap_or_default();
    if !npmrc_existing
        .lines()
        .any(|l| l.trim() == "confirmModulesPurge=false")
    {
        let mut content = npmrc_existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("confirmModulesPurge=false\n");
        fs::write(&npmrc_path, content).map_err(|e| format!("PROFILE_NPMRC_WRITE: {e}"))?;
    }

    Ok(())
}

/// 档案展示名（通知/还原结果等场景；目录缺失或 manifest 不可读时回落 id
/// 首字母大写，与列表展示一致）。
pub fn display_name(app_handle: &AppHandle, id: &str) -> String {
    manifest_display_name(&profile_dir_of(app_handle, id), id)
}

/// 写入依赖重建标记：下次启动对该档案按 manifest/lockfile 执行 `pnpm install`。
pub(crate) fn mark_dependency_rebuild(dir: &Path) -> Result<(), String> {
    fs::write(dir.join(REBUILD_MARKER), "")
        .map_err(|e| format!("PROFILE_REBUILD_MARKER_WRITE: {}: {e}", dir.display()))
}

/// 启动时调用：当前档案存在依赖重建标记时按 manifest/lockfile 执行 `pnpm install`
/// 重建直接依赖（复用预装插件完整性修复的同一套 pnpm 选版与子进程环境）。
pub(crate) async fn run_pending_dependency_rebuild(app_handle: &AppHandle) -> Result<(), String> {
    let profile_id = active_profile(app_handle);
    let dir = profile_dir_of(app_handle, &profile_id);
    if !dir.join(REBUILD_MARKER).is_file() {
        return Ok(());
    }
    log::info!(
        "profile dependency rebuild marker present for {profile_id}, running pnpm install"
    );
    crate::service::plugin::verify::repair_with_pnpm_install(app_handle, &dir).await?;
    fs::remove_file(dir.join(REBUILD_MARKER))
        .map_err(|e| format!("PROFILE_REBUILD_MARKER_REMOVE: {e}"))?;
    Ok(())
}

/// 克隆档案：`web` → `web-1`、`web-2`（源 id 后缀递增直到不冲突），
/// 或按 `name` 自定义新档案 id（校验见 [`validate_clone_name`]）。
///
/// 复制配置目录但排除依赖目录（`node_modules` / `.pnpm-store`）与临时标记
/// （`.dsh-rebuild-deps`），不跟随符号链接；并在克隆目录写入依赖重建标记——
/// 下次启动按 manifest/lockfile 执行 `pnpm install`，而非复制 `node_modules`。
pub fn clone(app_handle: &AppHandle, id: &str, name: Option<&str>) -> Result<Profile, String> {
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    let src = fs_guard::join_safe(&profiles_root, id)?;
    if id != DEFAULT_PROFILE && !src.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {id} does not exist"));
    }
    let new_id = match name {
        // 自定义名称：规范化后作为目录 id（空 / 字符 / 长度 / 保留 / 冲突均拒绝）
        Some(n) => validate_clone_name(&profiles_root, n)?,
        // 未指定：源 id 后缀递增
        None => next_clone_id(&profiles_root, id)?,
    };
    let dst = profile_dir_of(app_handle, &new_id);
    if src.is_dir() {
        copy_profile_tree(&src, &dst)?;
        // 克隆是独立档案：manifest name 与目录 id 保持一致
        // （dsh-profile-web → dsh-profile-web-1），展示名随 id 变化（Web-1），
        // 避免克隆与源档案同名难以区分；描述记录来源（克隆自 web）。
        update_manifest_meta(&dst, &format!("dsh-profile-{new_id}"), &clone_description(id))?;
    } else {
        // 源档案尚未初始化（如全新机器的 web）：直接按官方模板初始化
        init_profile_dir(&dst, &new_id)?;
    }
    mark_dependency_rebuild(&dst)?;
    Ok(Profile {
        id: new_id.clone(),
        name: manifest_display_name(&dst, &new_id),
        description: manifest_description(&dst),
        default: false,
        active: false,
    })
}

/// 校验并规范化克隆自定义名称（作为新档案目录 id）。
///
/// 与 [`create`] 同一套 `normalize_profile_id` 规则（小写、非字母数字转 `-`、
/// 压缩连续分隔符），并复用其校验口径：空输入、规范化后无可用字符、超过 64
/// 字符、内置默认档案保留名、目标目录已存在，均拒绝。
fn validate_clone_name(profiles_root: &Path, name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("PROFILE_CLONE_EMPTY_NAME: clone name is empty".to_string());
    }
    let id = normalize_profile_id(trimmed);
    if id.is_empty() {
        return Err("PROFILE_CLONE_INVALID_NAME: clone name has no usable characters".to_string());
    }
    if id.len() > 64 {
        return Err("PROFILE_CLONE_NAME_TOO_LONG: clone id exceeds 64 characters".to_string());
    }
    if id == DEFAULT_PROFILE {
        return Err("PROFILE_CLONE_RESERVED: this name is reserved".to_string());
    }
    if profiles_root.join(&id).exists() {
        return Err(format!("PROFILE_CLONE_EXISTS: profile {id} already exists"));
    }
    Ok(id)
}

/// 克隆档案的描述：`克隆自 <源>`（按当前界面语言生成，写入 manifest.description）。
fn clone_description(source_id: &str) -> String {
    let template = config::i18n::t("profile.clone_of");
    config::i18n::fill_template(&template, &[source_id])
}

/// 重命名档案（含描述）：更新 manifest 的 `name` / `description` 字段。
///
/// 只改展示元信息，目录 id 不变（`--profile <id>`、备份目录、依赖引用都不受影响）；
/// 展示名直接用用户输入（不再套 `dsh-profile-` 约定，避免中文等字符进入 npm 包名）。
pub fn update_meta(
    app_handle: &AppHandle,
    id: &str,
    name: &str,
    description: &str,
) -> Result<Profile, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("PROFILE_EMPTY_NAME: profile name is empty".to_string());
    }
    if trimmed_name.chars().count() > 64 {
        return Err("PROFILE_NAME_TOO_LONG: profile name exceeds 64 characters".to_string());
    }
    if trimmed_name.chars().any(|c| c.is_control()) {
        return Err("PROFILE_INVALID_NAME: profile name contains control characters".to_string());
    }
    let trimmed_description = description.trim();
    if trimmed_description.chars().count() > 200 {
        return Err("PROFILE_DESCRIPTION_TOO_LONG: description exceeds 200 characters".to_string());
    }
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    let dir = fs_guard::join_safe(&profiles_root, id)?;
    if !dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {id} does not exist"));
    }
    update_manifest_meta(&dir, trimmed_name, trimmed_description)?;
    list(app_handle)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "PROFILE_NOT_FOUND: profile disappeared after rename".to_string())
}

/// 更新档案 manifest 的 `name` / `description`（克隆与重命名共用）。
///
/// 只改这两个字段，其余字段（dependencies / bundles / private 等）原样保留。
fn update_manifest_meta(dir: &Path, name: &str, description: &str) -> Result<(), String> {
    let manifest_path = dir.join("package.json");
    if !manifest_path.is_file() {
        return Err("PROFILE_MANIFEST_MISSING: profile manifest not found".to_string());
    }
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("PROFILE_MANIFEST_READ: {e}"))?;
    let mut manifest: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("PROFILE_MANIFEST_INVALID: {e}"))?;
    if let Some(object) = manifest.as_object_mut() {
        object.insert("name".to_string(), serde_json::Value::String(name.to_string()));
        if description.is_empty() {
            object.remove("description");
        } else {
            object.insert(
                "description".to_string(),
                serde_json::Value::String(description.to_string()),
            );
        }
    }
    let rendered = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("PROFILE_MANIFEST_RENDER: {e}"))?;
    fs::write(&manifest_path, format!("{rendered}\n"))
        .map_err(|e| format!("PROFILE_MANIFEST_WRITE: {e}"))
}

/// 生成克隆目标 id：`<源id>-1`、`-2`… 递增直到不冲突（上限 999）。
fn next_clone_id(profiles_root: &Path, id: &str) -> Result<String, String> {
    for n in 1..=999 {
        let candidate = format!("{id}-{n}");
        if !profiles_root.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    Err(format!("PROFILE_CLONE_EXHAUSTED: no free clone id for {id}"))
}

/// 递归复制档案配置（排除依赖目录与临时标记；不跟随符号链接）。
fn copy_profile_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("PROFILE_MKDIR: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("PROFILE_COPY_READ: {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("PROFILE_COPY_ENTRY: {e}"))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(src)
            .map_err(|e| format!("PROFILE_COPY_PREFIX: {e}"))?;
        if is_excluded_from_backup(rel) {
            continue;
        }
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("PROFILE_COPY_META: {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if meta.is_dir() {
            copy_profile_tree(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|e| format!("PROFILE_COPY_FILE: {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_id_lowercases_and_joins() {
        assert_eq!(normalize_profile_id("My Work Space"), "my-work-space");
        assert_eq!(normalize_profile_id("  dev--stage  "), "dev-stage");
        assert_eq!(normalize_profile_id("中文档案"), "");
        assert_eq!(normalize_profile_id("a_b-c"), "a-b-c");
    }

    #[test]
    fn display_name_strips_manifest_prefix() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 无 manifest → 回落 id
        assert_eq!(manifest_display_name(&dir, "beta"), "Beta");
        // manifest 带 dsh-profile- 前缀 → 剥离后首字母大写
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"dsh-profile-beta","private":true}"#,
        )
        .unwrap();
        assert_eq!(manifest_display_name(&dir, "beta"), "Beta");
        // 非标准 name → 原样
        std::fs::write(dir.join("package.json"), r#"{"name":"my-profile"}"#).unwrap();
        assert_eq!(manifest_display_name(&dir, "beta"), "My-profile");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn init_profile_dir_scaffolds_official_shape() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-init-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        init_profile_dir(&dir, "beta").unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "dsh-profile-beta");
        assert_eq!(manifest["dependencies"], serde_json::json!({}));
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );
        assert!(dir.join("cordis.patch.yml").is_file());
        assert!(dir.join("pnpm-workspace.yaml").is_file());
        let npmrc = std::fs::read_to_string(dir.join(".npmrc")).unwrap();
        assert!(npmrc.contains("confirmModulesPurge=false"));

        // 幂等：再次初始化不报错、不重复写 .npmrc
        init_profile_dir(&dir, "beta").unwrap();
        let npmrc2 = std::fs::read_to_string(dir.join(".npmrc")).unwrap();
        assert_eq!(npmrc, npmrc2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 路径穿越回归：`..`、`.`、绝对路径、含分隔符的 id 一律在 remove 前被拦截，
    /// 绝不进入 `remove_dir_all`（防 `remove_profile("..")` 删到 $DSH_HOME 本级）。
    #[test]
    fn remove_rejects_path_traversal_ids() {
        for bad in ["..", ".", "../x", "/etc", "a/b", "..\\x", "a\\b"] {
            assert!(
                fs_guard::validate_id(bad).is_err(),
                "id {bad:?} 必须被字符集白名单拦截"
            );
        }
        for good in ["web", "my-profile", "dsh-1.2.3"] {
            assert!(fs_guard::validate_id(good).is_ok(), "id {good:?} 应合法");
        }
        // safe_remove_target 对不存在目标拒绝（不触发删除）
        let tmp = std::env::temp_dir().join(format!("dsh-profile-guard-{}", std::process::id()));
        let root = tmp.join("profiles");
        std::fs::create_dir_all(&root).unwrap();
        let res = std::panic::catch_unwind(|| {
            std::fs::create_dir_all(&root.join("web")).unwrap();
            let ok = crate::service::fs_guard::safe_remove_target(&root, "web");
            assert!(ok.is_ok(), "存在的合法目录应通过守卫: {ok:?}");
            let bad = crate::service::fs_guard::safe_remove_target(&root, "..");
            assert!(bad.is_err(), "`..` 必须被拒绝");
        });
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(res.is_ok(), "test panicked: {res:?}");
    }

    #[test]
    fn clone_id_increments_from_one() {
        let root = std::env::temp_dir().join(format!("dsh-profile-clone-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 无冲突 → web-1
        assert_eq!(next_clone_id(&root, "web").unwrap(), "web-1");
        // 占住 web-1 → web-2
        std::fs::create_dir_all(&root.join("web-1")).unwrap();
        assert_eq!(next_clone_id(&root, "web").unwrap(), "web-2");
        // 连续占住 → web-3
        std::fs::create_dir_all(&root.join("web-2")).unwrap();
        assert_eq!(next_clone_id(&root, "web").unwrap(), "web-3");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn validate_clone_name_normalizes_and_rejects_bad_inputs() {
        // 目录名前缀必须与 update_manifest_meta 等测试区分（并行运行互不干扰）
        let root = std::env::temp_dir().join(format!("dsh-profile-clone-validate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 规范化：与 create 同一套规则（小写、空格/下划线转 `-`、去首尾 `-`）
        assert_eq!(validate_clone_name(&root, "  My Work Space  ").unwrap(), "my-work-space");
        assert_eq!(validate_clone_name(&root, "dev_stage").unwrap(), "dev-stage");
        // 空 / 无可用字符 / 超长 / 保留名
        for bad in ["", "   ", "中文档案", "-", ".."] {
            assert!(validate_clone_name(&root, bad).is_err(), "name {bad:?} 应被拒绝");
        }
        let long = "x".repeat(65);
        let err = validate_clone_name(&root, &long).unwrap_err();
        assert!(err.contains("PROFILE_CLONE_NAME_TOO_LONG"), "got: {err}");
        let err = validate_clone_name(&root, "web").unwrap_err();
        assert!(err.contains("PROFILE_CLONE_RESERVED"), "got: {err}");
        // 已存在冲突
        std::fs::create_dir_all(root.join("dev")).unwrap();
        let err = validate_clone_name(&root, "Dev").unwrap_err();
        assert!(err.contains("PROFILE_CLONE_EXISTS"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn excluded_paths_cover_deps_and_markers() {
        assert!(is_excluded_from_backup(Path::new("node_modules")));
        assert!(is_excluded_from_backup(Path::new("node_modules/pkg/package.json")));
        assert!(is_excluded_from_backup(Path::new(".pnpm-store/state")));
        assert!(is_excluded_from_backup(Path::new(".dsh-rebuild-deps")));
        assert!(is_excluded_from_backup(Path::new("editor.tmp")));
        assert!(is_excluded_from_backup(Path::new("editor.TMP")));
        assert!(is_excluded_from_backup(Path::new("file.temp")));
        assert!(is_excluded_from_backup(Path::new("backup~")));
        assert!(is_excluded_from_backup(Path::new(".DS_Store")));
        assert!(is_excluded_from_backup(Path::new("Thumbs.db")));
        assert!(!is_excluded_from_backup(Path::new("package.json")));
        assert!(!is_excluded_from_backup(Path::new("custom/node_modules-not-me/config.json")));
        assert!(!is_excluded_from_backup(Path::new(".npmrc")));
        assert!(!is_excluded_from_backup(Path::new("pnpm-lock.yaml")));
        assert!(!is_excluded_from_backup(Path::new("config.toml")));
    }

    #[test]
    fn copy_profile_tree_skips_deps_and_markers() {
        let root = std::env::temp_dir().join(format!("dsh-profile-clone-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("web");
        let dst = root.join("web-1");
        std::fs::create_dir_all(&src.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(&src.join(".pnpm-store")).unwrap();
        std::fs::create_dir_all(&src.join("custom")).unwrap();
        std::fs::write(src.join("package.json"), r#"{"name":"dsh-profile-web"}"#).unwrap();
        std::fs::write(src.join("cordis.patch.yml"), "# patch\n").unwrap();
        std::fs::write(src.join("custom/user.json"), r#"{"x":1}"#).unwrap();
        std::fs::write(src.join("node_modules/pkg/package.json"), "{}").unwrap();
        std::fs::write(src.join(".pnpm-store/state"), "x").unwrap();
        std::fs::write(src.join(".dsh-rebuild-deps"), "").unwrap();

        copy_profile_tree(&src, &dst).unwrap();
        assert!(dst.join("package.json").is_file());
        assert!(dst.join("cordis.patch.yml").is_file());
        assert_eq!(
            std::fs::read_to_string(dst.join("custom/user.json")).unwrap(),
            r#"{"x":1}"#
        );
        assert!(!dst.join("node_modules").exists());
        assert!(!dst.join(".pnpm-store").exists());
        assert!(!dst.join(".dsh-rebuild-deps").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rebuild_marker_write_remove_roundtrip() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        mark_dependency_rebuild(&dir).unwrap();
        assert!(dir.join(REBUILD_MARKER).is_file());
        assert!(is_excluded_from_backup(Path::new(REBUILD_MARKER)));
        std::fs::remove_file(dir.join(REBUILD_MARKER)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn update_manifest_meta_makes_clone_distinguishable_and_supports_rename() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-clone-name-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 源 manifest 原样（name 为 dsh-profile-web）
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"dsh-profile-web","private":true,"dependencies":{"a":"1.0.0"}}"#,
        )
        .unwrap();
        // 克隆：name 随新 id + 描述记录来源
        update_manifest_meta(&dir, "dsh-profile-web-1", "克隆自 web").unwrap();
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "dsh-profile-web-1");
        assert_eq!(manifest["description"], "克隆自 web");
        // 其余字段保留（依赖不被重写丢失）
        assert_eq!(manifest["dependencies"]["a"], "1.0.0");
        assert_eq!(manifest["private"], true);
        // 展示名随 id 变化：Web-1；描述可读
        assert_eq!(manifest_display_name(&dir, "web-1"), "Web-1");
        assert_eq!(manifest_description(&dir), "克隆自 web");
        // 重命名：任意展示名 + 清空描述（空串移除字段）
        update_manifest_meta(&dir, "我的工作", "").unwrap();
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "我的工作");
        assert!(manifest.get("description").is_none());
        assert_eq!(manifest_display_name(&dir, "web-1"), "我的工作");
        // manifest 缺失时报错（不再静默跳过：改名必须落到真实档案上）
        std::fs::remove_file(dir.join("package.json")).unwrap();
        assert!(update_manifest_meta(&dir, "x", "").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
