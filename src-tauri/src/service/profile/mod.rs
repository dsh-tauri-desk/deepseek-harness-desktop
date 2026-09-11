//! 档案管理。
//!
//! 档案 = `$DSH_HOME/profiles/<id>` 目录，与官方 dsh CLI 的 profile 语义一致
//! （`dsh --profile <id>` 启动 / `dsh plugin --profile <id>` 管理插件）。
//! 桌面端把「当前使用哪个档案」持久化在自己的 store 设置（`active_profile`，
//! 默认 `web`），服务启动、插件安装/升级/卸载全部以它为准——不再写死 web。
//!
//! 首装防御：桌面端首次安装（本进程启动前 store 文件不存在）时，在任何 dsh
//! 启动/插件操作之前自动新建独立的 Desktop 档案并切换过去（见
//! `ensure_first_run_desktop_profile`）。此前装过 dsh CLI 并装了大量插件/补丁的
//! 用户启用桌面端时，旧数据不再涌入桌面端所用档案，防御性规避加载异常。
//!
//! 新建档案时按官方 `dsh-app-boot` 的 `initProfile` 形态初始化目录：
//! `package.json`（含 web 模板 bundles）+ `cordis.patch.yml` + `pnpm-workspace.yaml`，
//! 与 CLI 侧产物完全一致，两边可互相操作。
//!
//! 核心 bundle 层自愈（issue #452）：`dsh.profile.bundles` 必须始终带
//! `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`（顺序即补丁层应用顺序）。
//! 目录「已存在」不等于「档案已就绪」——CLI 侧 `dsh plugin add` 对没有
//! `package.json` 的目录会用 `DEFAULT_PROFILE_BUNDLES`（**只有 dsh-base**）初始化，
//! 中断的首次初始化、外部 mkdir、用户手工编辑清单都会留下缺 web 层的档案。此时
//! 宿主不会提供 webServer/connection/webRuntime，内置插件与市场插件全部停在
//! pending，服务启动必然失败。因此 [`init_profile_dir`] 与 spawn 前自愈
//! （[`ensure_active_profile_core_bundles`]）都会校核并**补齐**核心层：只前插
//! 缺失的核心 bundle，绝不删除或改写任何用户/内置插件条目。

use crate::config;
use crate::service::fs_guard;
use rayon::prelude::*;
use serde::Serialize;
use serde_yaml::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 桌面端默认档案（内置，不可删除）
pub const DEFAULT_PROFILE: &str = "web";

/// 首装引导档案：桌面端首次安装时自动新建并切换为当前档案（与 CLI 用户既有
/// 档案隔离；用户新建同 id 档案被 `PROFILE_EXISTS` 拦截，此名仅由本引导占用）。
pub const DESKTOP_PROFILE: &str = "desktop";

/// 安全模式档案：仅加载 web 模板核心 bundles、不带任何用户插件/补丁层。
/// 错误界面「安全模式」按钮切到此档案重启（`--profile safe`），隔离问题插件
/// 让应用先可用，用户随后在档案列表切回原档案即退出安全模式。
pub const SAFE_PROFILE: &str = "safe";

/// 新建档案的初始 bundles：web 模板（`@deepseek-ai/dsh-base` +
/// `@deepseek-ai/dsh-web-app`，与 dsh-app-boot `PROFILE_TEMPLATES.web` 一致）。
/// 桌面端内嵌的是 dsh web 应用，新档案不带 `dsh-web-app` 将无法渲染任何界面。
const WEB_PROFILE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// CLI 侧其它 surface 的 bundle（dsh-app-boot `PROFILE_TEMPLATES` 中除 web 外的
/// 模板）。它们与 web 层存在同名 insert 行（如 `code-runtime`），把 web 层叠加到
/// 这类档案上会让 loader 抛 `duplicate loader entry` 硬崩溃，因此核心 bundle 层
/// 自愈必须避开它们（见 [`ensure_profile_core_bundles`]）。
const NON_WEB_SURFACE_BUNDLES: [&str; 4] = [
    "@deepseek-ai/dsh-headless",
    "@deepseek-ai/dsh-acp-app",
    "@deepseek-ai/dsh-sdk-app",
    "@deepseek-ai/dsh-sdk-minimal",
];

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
                default: id == DEFAULT_PROFILE,
                active: id == active,
            });
        }
    }
    if !out.iter().any(|p| p.id == DEFAULT_PROFILE) {
        out.push(Profile {
            id: DEFAULT_PROFILE.to_string(),
            name: "Web".to_string(),
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

/// 确保首装引导档案目录存在且含核心 web bundle 层（以 `profiles_root` 注入，便于单测）。
///
/// 幂等且绝不覆盖：目录已存在（含 CLI 侧手动创建的同名档案）时复用其依赖、
/// 插件与补丁层，只补齐缺失的档案文件与核心 bundle 条目。**不能只判断目录是否
/// 存在**：`dsh plugin add` 对无 `package.json` 的目录会按 `DEFAULT_PROFILE_BUNDLES`
/// （仅 dsh-base）初始化，若把这种半初始化目录当作「已就绪」，缺失的
/// `@deepseek-ai/dsh-web-app` 会让桌面端此后每次启动都失败（issue #452）。
fn ensure_desktop_profile_with_root(profiles_root: &Path) -> Result<(), String> {
    init_profile_dir(&profiles_root.join(DESKTOP_PROFILE), DESKTOP_PROFILE)
}

/// 首装档案引导：桌面端首次安装时新建独立的 Desktop 档案并切换为当前档案。
///
/// 为什么：此前装过 dsh CLI 并装了大量插件/补丁的用户，启用桌面端时这些旧
/// 数据会涌入桌面端所用档案导致加载异常；首装即隔离到干净档案可防御性规避。
/// 老用户（store 已存在）绝不动其档案选择。幂等 + 最佳努力：已引导过
/// （`desktop_profile_ready`）或任何一步失败时跳过并告警，回落 web 档案的
/// 老行为，绝不阻断启动。调用时机：desktop::setup（前端可操作之前，让安装
/// 向导/预装插件/内置插件全部落进 Desktop 档案）与 launch（spawn dsh 前重试）。
pub fn ensure_first_run_desktop_profile(app_handle: &AppHandle) {
    if !config::is_first_install() {
        return;
    }
    if config::get_store_dat_setting(app_handle).desktop_profile_ready {
        return;
    }
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    if let Err(e) = ensure_desktop_profile_with_root(&profiles_root) {
        log::warn!("first-run Desktop profile init failed: {e}");
        return;
    }
    if let Err(e) = set_active(app_handle, DESKTOP_PROFILE) {
        log::warn!("first-run Desktop profile switch failed: {e}");
        return;
    }
    config::update_store_dat_setting(app_handle, |setting| {
        setting.desktop_profile_ready = true;
    });
    log::info!("First-run bootstrap: Desktop profile created and activated ({DESKTOP_PROFILE})");
}

/// 确保安全模式档案目录存在且含核心 web bundle 层（幂等，绝不覆盖用户改动）。
///
/// 与 `ensure_desktop_profile_with_root` 同构：已存在时复用档案内容，只补齐缺失的
/// 档案文件与核心 bundle 条目（web 模板 bundles，可正常渲染桌面内嵌的 web UI）。
/// 安全档案只含核心 bundles 与空 patch 层——不装任何用户插件，用于错误界面
/// 「安全模式」按钮把问题插件隔离在启动链路之外。
pub fn ensure_safe_profile(app_handle: &AppHandle) -> Result<(), String> {
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    init_profile_dir(&profiles_root.join(SAFE_PROFILE), SAFE_PROFILE)
}

/// 删除档案（默认档案与使用中的档案不可删除）。
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
    fs::remove_dir_all(&dir).map_err(|e| format!("PROFILE_REMOVE_FAILED: {e}"))
}

/// 克隆档案：全量复制源档案目录，自动递增命名（web → web-1 → web-2）。
///
/// - `source_id` 经 `fs_guard::validate_id` 校验，拒绝路径穿越；
/// - `name` 为 `None` 时按 source_id 自动递增；`Some` 时规范化并校验冲突；
/// - 复制后清除搬入的 pnpm 元数据（`.modules.yaml`），并重写 manifest name 为
///   `dsh-profile-<new-id>`。
pub fn clone(app_handle: &AppHandle, source_id: &str, name: Option<&str>) -> Result<Profile, String> {
    let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
    clone_with_root(&profiles_root, source_id, name)
}

/// 克隆实现（以 `profiles_root` 为根，便于单测注入临时目录）。
pub fn clone_with_root(profiles_root: &Path, source_id: &str, name: Option<&str>) -> Result<Profile, String> {
    fs_guard::validate_id(source_id)?;
    let src_dir = fs_guard::join_safe(profiles_root, source_id)?;
    if !src_dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {source_id} does not exist"));
    }

    let new_id = match name {
        Some(n) => {
            let trimmed = n.trim();
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
            let target = profiles_root.join(&id);
            if target.is_dir() {
                return Err(format!("PROFILE_EXISTS: profile {id} already exists"));
            }
            id
        }
        None => next_profile_id(profiles_root, source_id)?,
    };

    let dst_dir = profiles_root.join(&new_id);
    copy_dir_tree(&src_dir, &dst_dir)?;
    crate::service::migrate::purge_carried_pnpm_metadata(&dst_dir);
    rewrite_manifest_name(&dst_dir, &new_id)?;

    Ok(Profile {
        id: new_id.clone(),
        name: manifest_display_name(&dst_dir, &new_id),
        default: false,
        active: false,
    })
}

/// 解析下一个未占用的自动递增 id（base → base-1 → base-2 …，上限 1000）。
fn next_profile_id(profiles_root: &Path, base: &str) -> Result<String, String> {
    let mut n = 1;
    loop {
        if n > 1000 {
            return Err("PROFILE_CLONE_EXHAUSTED: too many clones".to_string());
        }
        let candidate = format!("{base}-{n}");
        if !profiles_root.join(&candidate).is_dir() {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// 递归复制目录树到全新目标（跳过 profile 根下隐藏目录，保留 `.npmrc`）。
///
/// 顶层目录串行创建后，同级条目用 rayon `par_iter` 并行处理：目录递归、文件
/// `fs::copy` 并发执行，大幅加速大档案（含 node_modules）的克隆。
fn copy_dir_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("COPY_MKDIR: {e}"))?;
    let read_dir = fs::read_dir(src).map_err(|e| format!("COPY_READ: {e}"))?;
    let entries: Vec<_> = read_dir
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("COPY_ENTRY: {e}"))?;
    entries.par_iter().try_for_each(|entry| -> Result<(), String> {
        let name = entry.file_name();
        // 仅跳过运行时产物（不随克隆迁移）
        if let Some(s) = name.to_str() {
            if s == ".harness.pid" || s == ".backups" {
                return Ok(());
            }
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        let ty = entry.file_type().map_err(|e| format!("COPY_TYPE: {e}"))?;
        if ty.is_symlink() {
            // 保留符号链接原样（如 node_modules/.bin 下的可执行链接）
            let target = std::fs::read_link(&src_path)
                .map_err(|e| format!("COPY_LINK_READ: {e}"))?;
            copy_symlink(&target, &dst_path)?;
        } else if ty.is_dir() {
            copy_dir_tree(&src_path, &dst_path)?;
        } else if ty.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| format!("COPY_FILE: {e}"))?;
        }
        Ok(())
    })?;
    Ok(())
}

/// 在目标位置重建一条符号链接（指向原链接相同的目标）。
#[cfg(unix)]
fn copy_symlink(target: &std::path::Path, dst: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, dst)
        .map_err(|e| format!("COPY_LINK_CREATE: {e}"))
}

/// 在目标位置重建一条符号链接（Windows 下需要权限，best-effort）。
#[cfg(windows)]
fn copy_symlink(target: &std::path::Path, dst: &Path) -> Result<(), String> {
    // Windows 符号链接需要管理员权限，目录联接不需要但仅限目录。
    // best-effort：失败不阻断克隆，仅记录告警。
    if dst.parent().is_some() {
        let _ = std::os::windows::fs::symlink_dir(target, dst)
            .or_else(|_| std::os::windows::fs::symlink_file(target, dst))
            .map_err(|e| log::warn!("copy_symlink failed for {}: {e}", dst.display()));
    }
    Ok(())
}

/// 重写克隆档案 manifest 的 `name` 字段为 `dsh-profile-<new-id>`。
fn rewrite_manifest_name(dir: &Path, new_id: &str) -> Result<(), String> {
    let path = dir.join("package.json");
    let content = fs::read_to_string(&path).map_err(|e| format!("MANIFEST_READ: {e}"))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("MANIFEST_PARSE: {e}"))?;
    if let Some(obj) = manifest.as_object_mut() {
        obj.insert(
            "name".to_string(),
            serde_json::Value::String(format!("dsh-profile-{new_id}")),
        );
    }
    let rendered = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("MANIFEST_RENDER: {e}"))?;
    fs::write(&path, format!("{rendered}\n"))
        .map_err(|e| format!("MANIFEST_WRITE: {e}"))
}

/// 初始化档案目录：与官方 `dsh-app-boot::initProfile` 的产物一致
/// 官方 `initProfile` 形态的档案清单（web 模板 bundles）。
fn web_profile_manifest(id: &str) -> serde_json::Value {
    serde_json::json!({
        "name": format!("dsh-profile-{id}"),
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": WEB_PROFILE_BUNDLES } }
    })
}

/// 校核并补齐档案的核心 web bundle 层，返回是否写回了清单。
///
/// 覆盖三种状态，全部只做「补齐」、绝不删除或改写其它字段：
/// - 清单缺失（目录被外部创建、初始化中断、被清理）→ 按官方 `initProfile` 形态
///   写入 web 模板清单；
/// - 清单存在但缺核心 bundle（典型：`dsh plugin add` 用
///   `DEFAULT_PROFILE_BUNDLES` 初始化出的「只有 dsh-base + 插件」档案）→ 把核心
///   bundle 前插回列表头部，保持 `dsh-base` → `dsh-web-app` 的补丁应用顺序；
/// - 清单已含核心 bundle → 不写盘（幂等，避免无谓改写用户文件）。
///
/// 清单不可读/不可解析（外部截断、非对象、`dsh`/`profile` 非对象）时报错交由
/// 调用方告警：这种状态可能承载用户数据，宁可留着让人工处理，也绝不静默重建。
///
/// 非 web 表面的档案（CLI 侧 headless/acp/sdk 模板）一律不动：它们与 web 层有
/// 同名 insert（如 `code-runtime`），叠加会触发 `duplicate loader entry` 硬崩溃；
/// 桌面端无法承载这类档案，但绝不能为了「修好桌面端」而破坏 CLI 用途的档案。
fn ensure_profile_core_bundles(dir: &Path, id: &str) -> Result<bool, String> {
    let manifest_path = dir.join("package.json");
    let mut manifest: serde_json::Value = match fs::read_to_string(&manifest_path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            format!(
                "PROFILE_MANIFEST_PARSE_FAILED: {}: {e}",
                manifest_path.display()
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(|e| format!("PROFILE_MKDIR: {e}"))?;
            let manifest = web_profile_manifest(id);
            write_profile_manifest_file(&manifest_path, &manifest)?;
            log::info!(
                "Profile manifest created with the official web template: {}",
                manifest_path.display()
            );
            return Ok(true);
        }
        Err(error) => {
            return Err(format!(
                "PROFILE_MANIFEST_READ_FAILED: {}: {error}",
                manifest_path.display()
            ))
        }
    };

    let existing = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array);
    let current: Vec<String> = existing
        .map(|bundles| {
            bundles
                .iter()
                .filter_map(|bundle| bundle.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if let Some(foreign) = current
        .iter()
        .find(|bundle| NON_WEB_SURFACE_BUNDLES.contains(&bundle.as_str()))
    {
        log::warn!(
            "PROFILE_CORE_BUNDLES_SKIPPED: profile {id} is a non-web dsh surface ({foreign}); \
             leaving {} untouched (the web layer would duplicate loader entries)",
            manifest_path.display()
        );
        return Ok(false);
    }

    // 核心层固定在列表最前（补丁层按 `dsh.profile.bundles` 顺序应用，
    // dsh-web-app 的覆写行必须在 dsh-base 之后落地）；其余条目原样保留相对顺序，
    // 因此已就绪的档案得到与输入完全一致的列表（幂等）。
    let mut desired: Vec<String> = WEB_PROFILE_BUNDLES
        .iter()
        .map(|bundle| (*bundle).to_string())
        .collect();
    desired.extend(
        current
            .iter()
            .filter(|bundle| !WEB_PROFILE_BUNDLES.contains(&bundle.as_str()))
            .cloned(),
    );
    if existing.is_some() && current == desired {
        return Ok(false);
    }

    let root = manifest
        .as_object_mut()
        .ok_or_else(|| format!("PROFILE_MANIFEST_NOT_OBJECT: {}", manifest_path.display()))?;
    let dsh = root
        .entry("dsh".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "PROFILE_MANIFEST_DSH_NOT_OBJECT: {}",
                manifest_path.display()
            )
        })?;
    let profile = dsh
        .entry("profile".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            format!(
                "PROFILE_MANIFEST_PROFILE_NOT_OBJECT: {}",
                manifest_path.display()
            )
        })?;
    profile.insert("bundles".to_string(), serde_json::json!(desired));
    write_profile_manifest_file(&manifest_path, &manifest)?;
    log::warn!(
        "PROFILE_CORE_BUNDLES_RESTORED: profile {id} was missing the web core bundle layer; \
         restored {:?} before {:?} in {}",
        WEB_PROFILE_BUNDLES,
        current,
        manifest_path.display()
    );
    Ok(true)
}

/// 写回档案清单（pretty JSON + 尾换行，与 dsh `initProfile` 产物形态一致）。
///
/// 同目录临时文件 + rename 原子替换（与 `service::plugin::internal` 的清单写回同
/// 一策略）：写入中途崩溃/断电不会留下截断的 `package.json`——不可解析的清单不在
/// 自愈范围内（可能承载用户数据，只报错不重建），截断即等于把可恢复状态变成
/// 永久不可恢复。
fn write_profile_manifest_file(path: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("PROFILE_MANIFEST_RENDER: {e}"))?;
    let temp = path.with_extension(format!("json.profile.{}.tmp", std::process::id()));
    if let Err(e) = fs::write(&temp, format!("{content}\n")) {
        let _ = fs::remove_file(&temp);
        return Err(format!("PROFILE_MANIFEST_WRITE: {e}"));
    }
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!("PROFILE_MANIFEST_WRITE: {e}"));
    }
    Ok(())
}

/// spawn dsh 之前调用：确保当前档案带上桌面端内嵌 web UI 依赖的核心 bundle 层。
///
/// 返回是否发生了补齐。`web` 等官方模板档案缺失时交由 dsh 按模板初始化（这里
/// 不抢先建目录）；档案已存在但缺核心层（issue #452 的「只有 dsh-base + 插件」
/// 形态：宿主不提供 webServer/connection，内置插件恒为 pending，服务必然启动
/// 失败）时补齐并写回，令本轮启动即可恢复。
pub fn ensure_active_profile_core_bundles(app_handle: &AppHandle) -> Result<bool, String> {
    let id = active_profile(app_handle);
    let dir = profile_dir_of(app_handle, &id);
    if !dir.is_dir() {
        return Ok(false);
    }
    ensure_profile_core_bundles(&dir, &id)
}

/// 初始化档案目录：与官方 `dsh-app-boot::initProfile` 的产物一致
/// （web 模板 bundles；已有文件绝不覆盖，重跑为 no-op），并补齐既有清单缺失的
/// 核心 web bundle 层（见 [`ensure_profile_core_bundles`]）。
fn init_profile_dir(dir: &Path, id: &str) -> Result<(), String> {
    // 建目录 + 真实写入探测：目录已存在但属主不是当前用户时（issue #466，典型：
    // 此前用 sudo 运行过 dsh），std 的 `create_dir_all` 会直接返回 Ok，直到后面
    // 写清单才以裸 EACCES 失败——安全模式报的 `PROFILE_MKDIR: Permission denied`
    // 就是这条路径。用 perm 的探测把「不可写 + 属主 + chown 命令」在最早一步给出。
    crate::service::perm::ensure_dir_writable(dir, "PROFILE_MKDIR")?;

    ensure_profile_core_bundles(dir, id)?;

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

#[cfg(test)]
mod clone_tests {
    use super::*;
    use std::path::PathBuf;

    /// 在 profiles 根目录下构造一个最小源档案目录，返回其路径。
    fn scaffold_source(root: &PathBuf, id: &str) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"dsh-profile-{id}","private":true}}"#),
        )
        .unwrap();
        std::fs::write(dir.join("cordis.patch.yml"), "# patch\n[]\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/deep.txt"), "nested content").unwrap();
        dir
    }

    #[test]
    fn clone_produces_independent_copy_with_incremented_name() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        scaffold_source(&root, "web");

        let profile = clone_with_root(&root, "web", None).unwrap();
        assert_eq!(profile.id, "web-1");
        assert!(!profile.default);
        assert!(!profile.active);

        let dst = root.join("web-1");
        assert!(dst.is_dir(), "cloned dir must exist");
        assert!(dst.join("package.json").is_file());
        assert!(dst.join("cordis.patch.yml").is_file());
        assert!(dst.join("sub/deep.txt").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clone_skips_taken_names() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        scaffold_source(&root, "web");
        std::fs::create_dir_all(root.join("web-1")).unwrap();
        std::fs::write(root.join("web-1/package.json"), r#"{"name":"dsh-profile-web-1"}"#).unwrap();

        let profile = clone_with_root(&root, "web", None).unwrap();
        assert_eq!(profile.id, "web-2");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clone_rewrites_manifest_name() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        scaffold_source(&root, "web");

        let profile = clone_with_root(&root, "web", None).unwrap();
        let dst = root.join(&profile.id);
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dst.join("package.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], format!("dsh-profile-{}", profile.id));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clone_rejects_traversal_id() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-traversal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        scaffold_source(&root, "web");

        let err = clone_with_root(&root, "..", None).unwrap_err();
        assert!(
            err.contains("INVALID_ID") || err.contains("INVALID"),
            "expected traversal rejection, got: {err}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clone_of_missing_source_returns_not_found() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");

        let err = clone_with_root(&root, "nonexistent", None).unwrap_err();
        assert!(err.contains("PROFILE_NOT_FOUND"), "expected PROFILE_NOT_FOUND, got: {err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clone_purges_carried_pnpm_metadata() {
        let tmp = std::env::temp_dir().join(format!("dsh-clone-pnpm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        scaffold_source(&root, "web");
        let nm = root.join("web/node_modules");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join(".modules.yaml"), "lockfileVersion: '9.0'\nstoreDir: /old/store\n").unwrap();

        let profile = clone_with_root(&root, "web", None).unwrap();
        let dst_nm = root.join(&profile.id).join("node_modules");
        assert!(dst_nm.is_dir(), "node_modules should be copied");
        assert!(!dst_nm.join(".modules.yaml").exists(), "carried .modules.yaml must be purged");

        let _ = std::fs::remove_dir_all(&tmp);
    }
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

    /// 首装引导档案：初始化产物与官方 initProfile 形态一致，且已存在时绝不覆盖。
    #[test]
    fn desktop_bootstrap_creates_official_shape_once() {
        let tmp = std::env::temp_dir().join(format!("dsh-profile-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");

        ensure_desktop_profile_with_root(&root).unwrap();
        let dir = root.join(DESKTOP_PROFILE);
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "dsh-profile-desktop");
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );
        assert!(dir.join("cordis.patch.yml").is_file());
        assert!(dir.join("pnpm-workspace.yaml").is_file());
        let npmrc = std::fs::read_to_string(dir.join(".npmrc")).unwrap();
        assert!(npmrc.contains("confirmModulesPurge=false"));

        // 幂等：目录已存在时直接复用，绝不覆盖用户改动
        std::fs::write(dir.join("cordis.patch.yml"), "# user edit\n[]\n").unwrap();
        ensure_desktop_profile_with_root(&root).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("cordis.patch.yml")).unwrap(),
            "# user edit\n[]\n"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// issue #452 回归：`dsh plugin add` 会把缺 `package.json` 的目录按
    /// `DEFAULT_PROFILE_BUNDLES`（只有 dsh-base）初始化，留下「缺 web 层」的档案；
    /// 引导必须把核心层补回列表最前，且不动用户/内置插件条目与其它字段。
    #[test]
    fn core_bundles_restored_before_plugin_entries_without_touching_other_fields() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "name": "dsh-profile-desktop",
            "private": true,
            "dependencies": { "dsh-tauri-pet": "link:C:/app/resources/node_modules/dsh-tauri-pet" },
            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-tauri-pet", "dsh-better-sidebar"] } }
        });
        std::fs::write(
            dir.join("package.json"),
            format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
        )
        .unwrap();

        assert!(ensure_profile_core_bundles(&dir, "desktop").unwrap());

        let repaired: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        // 核心层回到最前（顺序 = 补丁层应用顺序：base 先、web-app 后），用户插件保序
        assert_eq!(
            repaired["dsh"]["profile"]["bundles"],
            serde_json::json!([
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "dsh-tauri-pet",
                "dsh-better-sidebar"
            ])
        );
        // 依赖声明、名称等其它字段原样保留
        assert_eq!(repaired["name"], "dsh-profile-desktop");
        assert_eq!(
            repaired["dependencies"]["dsh-tauri-pet"],
            "link:C:/app/resources/node_modules/dsh-tauri-pet"
        );

        // 幂等：已含核心层的档案不再写盘（内容逐字节不变）
        let before = std::fs::read_to_string(dir.join("package.json")).unwrap();
        assert!(!ensure_profile_core_bundles(&dir, "desktop").unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("package.json")).unwrap(),
            before
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 非 web 表面（CLI 的 headless/acp/sdk 档案）不参与 web 层补齐：web 层与其
    /// 存在同名 insert（`code-runtime`），叠加会 duplicate loader entry 硬崩溃。
    #[test]
    fn core_bundles_repair_skips_non_web_surfaces() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-surface-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let raw = r#"{"name":"dsh-profile-headless","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}"#;
        std::fs::write(dir.join("package.json"), raw).unwrap();

        assert!(!ensure_profile_core_bundles(&dir, "headless").unwrap());
        assert_eq!(
            std::fs::read_to_string(dir.join("package.json")).unwrap(),
            raw,
            "non-web surface profile must stay untouched"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 目录存在但清单缺失（初始化中断 / 外部 mkdir / 被清理）→ 补写官方 web 模板清单。
    #[test]
    fn core_bundles_seeded_when_manifest_is_missing() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!dir.join("package.json").exists());

        assert!(ensure_profile_core_bundles(&dir, "desktop").unwrap());

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "dsh-profile-desktop");
        assert_eq!(manifest["private"], true);
        assert_eq!(manifest["dependencies"], serde_json::json!({}));
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 清单可损坏但可能承载用户数据：解析失败时只报错，绝不静默重建/改写。
    #[test]
    fn core_bundles_repair_refuses_to_clobber_corrupt_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-profile-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for raw in [
            "{ not json",
            "[]",
            r#"{"dsh":"x"}"#,
            r#"{"dsh":{"profile":"y"}}"#,
        ] {
            std::fs::write(dir.join("package.json"), raw).unwrap();
            assert!(
                ensure_profile_core_bundles(&dir, "desktop").is_err(),
                "corrupt manifest {raw:?} must be reported, not rewritten"
            );
            assert_eq!(
                std::fs::read_to_string(dir.join("package.json")).unwrap(),
                raw,
                "corrupt manifest {raw:?} must stay untouched"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 首装引导必须修复「目录已存在但缺 web 层」的半初始化档案（issue #452 形态）。
    #[test]
    fn desktop_bootstrap_repairs_partially_initialized_profile() {
        let tmp = std::env::temp_dir().join(format!("dsh-profile-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("profiles");
        let dir = root.join(DESKTOP_PROFILE);
        std::fs::create_dir_all(&dir).unwrap();
        // `dsh plugin add` 的初始化产物：只有 dsh-base + 插件，没有任何 web 层
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"dsh-profile-desktop","private":true,"dependencies":{"dsh-tauri":"link:C:/app/resources/node_modules/dsh-tauri"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-tauri"]}}}"#,
        )
        .unwrap();

        ensure_desktop_profile_with_root(&root).unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!([
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "dsh-tauri"
            ])
        );
        // 档案的其余文件同样补齐（半初始化目录 → 完整档案）
        assert!(dir.join("cordis.patch.yml").is_file());
        assert!(dir.join("pnpm-workspace.yaml").is_file());

        let _ = std::fs::remove_dir_all(&tmp);
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
}
