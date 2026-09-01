//! 插件清单：分别读取随安装包分发的 `resources/preset-plugins.json` 与
//! `resources/internal-plugins.json`，弃用名单单独维护在
//! `resources/deprecated-plugins.json`（只登记预设插件 id，不参与预设合并）。
//!
//! 社区预设与内部插件分开维护；运行时合并为统一结构供安装、展示与自愈逻辑使用。
//! 资源缺失/损坏时报错并回落为空清单，不阻断启动。

use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::config;

/// 预设插件清单文件名
const PRESET_PLUGINS_FILE: &str = "preset-plugins.json";
/// 内部插件清单文件名
const INTERNAL_PLUGINS_FILE: &str = "internal-plugins.json";
/// 弃用插件清单文件名（只登记预设插件 id）
const DEPRECATED_PLUGINS_FILE: &str = "deprecated-plugins.json";

/// 插件静态信息，对应预设或内部插件清单中的条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallPluginInfo {
    /// 前端主键 / 仓库跳转查找键
    pub id: String,
    /// 传给 `dsh plugin add` 的依赖形式（npm 包名或 git 依赖形式）
    pub spec: String,
    /// 内置插件：条目来自发布清单，或 debug 下仓库根 `packages/*` 中带有
    /// 有效 `dsh` 对象的 workspace 包。内置插件固定从本地捆绑目录安装，启动时
    /// 强制核对「已安装 + 路径指向当前捆绑目录」，因此不出现在首次引导清单里。
    #[serde(default)]
    pub internal: bool,
    /// 安装进 profile 后实际出现在 `dependencies`/`bundles` 里的包名。
    /// 默认与 `id` 相同；scoped 包或 id 与包名不同时显式指定。
    #[serde(default)]
    pub package: Option<String>,
    pub name: String,
    pub description: String,
    pub repo_url: String,
    /// 绿色「推荐」chip，默认勾选（普通推荐插件）
    #[serde(default)]
    pub recommended: bool,
    /// 黄色「修复」chip，默认勾选（Windows 极简模式修复项）
    #[serde(default)]
    pub fix: bool,
    /// 无 chip 但默认勾选（如 dsh-notification：不标「推荐」，首次引导仍直接勾上）
    #[serde(default)]
    pub default_checked: bool,
    /// 仅 Windows 平台列出
    #[serde(default)]
    pub win_only: bool,
}

/// debug workspace 插件 package.json 中用于生成内置元数据的字段。
#[cfg(debug_assertions)]
#[derive(Clone, Deserialize, Default)]
struct DevPluginPackageJson {
    #[serde(default)]
    name: Option<String>,
    /// `private: true` 的包（bundler、工具包与演示占位插件）不参与内置插件发现
    #[serde(default)]
    private: bool,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<serde_json::Value>,
    #[serde(default)]
    dsh: Option<serde_json::Value>,
}

#[cfg(debug_assertions)]
struct DevPluginCandidate {
    info: PreinstallPluginInfo,
    directory: PathBuf,
}

#[cfg(debug_assertions)]
fn dev_plugins_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("packages")
}

#[cfg(debug_assertions)]
fn normalize_dev_repo_url(value: &str) -> String {
    let mut url = value.trim().to_string();
    if let Some(rest) = url.strip_prefix("git+") {
        url = rest.to_string();
    }
    if let Some(rest) = url.strip_prefix("git://") {
        url = format!("https://{rest}");
    }
    if let Some(rest) = url.strip_suffix(".git") {
        url = rest.to_string();
    }
    url
}

#[cfg(debug_assertions)]
fn dev_repo_url(manifest: &DevPluginPackageJson) -> String {
    let repository = manifest.repository.as_ref().and_then(|repository| {
        repository
            .as_str()
            .or_else(|| repository.get("url").and_then(serde_json::Value::as_str))
    });
    repository
        .or(manifest.homepage.as_deref())
        .map(normalize_dev_repo_url)
        .unwrap_or_default()
}

/// 扫描指定 workspace 根目录下的开发插件。
///
/// 只有 package.json 可解析、非私有（无 `private: true`）、name 非空且 `dsh` 是
/// 对象的目录才是内置插件；扫描失败只跳过当前目录，不阻断桌面端启动。目录名不
/// 参与插件身份判定，因此 package.name 与目录名不一致时仍使用真实 npm 包名作为
/// id、依赖键和 node_modules 路径。`private: true` 的包（bundler、工具包与演示
/// 占位插件）不是可发布的内置插件，即使含 `dsh` 也一并忽略。
#[cfg(debug_assertions)]
fn discover_dev_internal_plugins_at(root: &Path) -> Vec<DevPluginCandidate> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry)
        })
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter_map(|entry| {
            let directory = entry.path();
            let manifest_path = directory.join("package.json");
            let raw = std::fs::read_to_string(&manifest_path).ok()?;
            let manifest = match serde_json::from_str::<DevPluginPackageJson>(&raw) {
                Ok(manifest) => manifest,
                Err(error) => {
                    log::warn!(
                        "DEV_INTERNAL_PLUGIN_MANIFEST_INVALID: {}: {error}",
                        manifest_path.display()
                    );
                    return None;
                }
            };
            if manifest.private {
                return None;
            }
            if !manifest
                .dsh
                .as_ref()
                .is_some_and(serde_json::Value::is_object)
            {
                return None;
            }
            // 先借出 repository/homepage 计算 repo_url，再消费 name / description：
            // 三者都来自同一 manifest，顺序错开会在部分移动后再借用。
            let repo_url = dev_repo_url(&manifest);
            let name = manifest.name.filter(|name| !name.trim().is_empty())?;
            if !seen.insert(name.clone()) {
                log::warn!("DEV_INTERNAL_PLUGIN_DUPLICATE: {name}");
                return None;
            }
            let info = PreinstallPluginInfo {
                id: name.clone(),
                spec: name.clone(),
                internal: true,
                package: Some(name.clone()),
                name: name.clone(),
                description: manifest.description.unwrap_or_default(),
                repo_url,
                recommended: false,
                fix: false,
                default_checked: false,
                win_only: false,
            };
            Some(DevPluginCandidate { info, directory })
        })
        .collect()
}

#[cfg(debug_assertions)]
fn discover_dev_internal_plugins() -> Vec<DevPluginCandidate> {
    discover_dev_internal_plugins_at(&dev_plugins_root())
}

/// 按 id 定位仓库根 `packages/<name>` 下的开发插件源码目录（debug 专用）。
///
/// 返回整个扫描结果再按 id 匹配：发现的候选已由 package.json 校验过，因此命中即
/// 目录有效。重扫描是磁盘开销，但仅 debug 构建、且目录数很少，安全。
#[cfg(debug_assertions)]
fn dev_plugin_dir(id: &str) -> Option<PathBuf> {
    discover_dev_internal_plugins()
        .into_iter()
        .find(|candidate| candidate.info.id == id)
        .map(|candidate| candidate.directory)
}

/// 把仓库根 `packages/*` 发现的内置插件合并进静态 `internal-plugins.json` 清单。
///
/// 同名 dev 候选覆盖静态条目（开发时以仓库源码为准，安装目标指到 `packages/`）；
/// 未在静态清单中出现的 dev 插件会被追加，保证 debug 观察到的内置插件集合
/// 以仓库源码为准，与 release（只认随包分发的静态清单）共用同一套安装/自愈逻辑。
#[cfg(debug_assertions)]
fn merge_dev_internal_plugins(internal: Vec<PreinstallPluginInfo>) -> Vec<PreinstallPluginInfo> {
    merge_dev_internal_plugins_at(&dev_plugins_root(), internal)
}

/// [`merge_dev_internal_plugins`] 的根目录参数化版本，便于单测注入临时扫描根。
#[cfg(debug_assertions)]
fn merge_dev_internal_plugins_at(
    root: &Path,
    mut internal: Vec<PreinstallPluginInfo>,
) -> Vec<PreinstallPluginInfo> {
    let mut by_id: std::collections::HashMap<String, DevPluginCandidate> =
        discover_dev_internal_plugins_at(root)
            .into_iter()
            .map(|candidate| (candidate.info.id.clone(), candidate))
            .collect();
    for plugin in internal.iter_mut() {
        if let Some(candidate) = by_id.remove(&plugin.id) {
            *plugin = candidate.info;
        }
    }
    internal.extend(by_id.into_values().map(|candidate| candidate.info));
    internal
}

/// 在资源根目录下查找清单：先探测扁平布局（exe 同级），再探测
/// `resources/` 子目录布局（Tauri 2 的 `bundle.resources` 按相对路径保留前缀）。
fn find_manifest_in_resource_root(root: &std::path::Path, file_name: &str) -> Option<PathBuf> {
    let flat = root.join(file_name);
    if flat.exists() {
        return Some(flat);
    }
    let nested = root.join("resources").join(file_name);
    nested.exists().then_some(nested)
}

/// 定位插件清单文件：优先使用随安装包分发的资源目录，回落到源码开发目录。
///
/// 注意：Tauri 2 在 Windows 上 `resource_dir()` 恒等于 exe 所在目录，而安装包
/// （NSIS/MSI）与开发产物都会把资源按 `resources/**` 前缀落盘到
/// `{resource_dir}/resources/` 子目录，因此必须探测该子目录；`CARGO_MANIFEST_DIR`
/// 是编译期路径，仅开发机有效（CI/发布版在本机不可用），只作最后兜底。
fn plugins_manifest_path(app_handle: &AppHandle, file_name: &str) -> Option<PathBuf> {
    if let Ok(dir) = app_handle.path().resource_dir() {
        if let Some(candidate) = find_manifest_in_resource_root(&dir, file_name) {
            return Some(candidate);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(file_name);
    source.exists().then_some(source)
}

fn preset_plugins_path(app_handle: &AppHandle) -> Option<PathBuf> {
    plugins_manifest_path(app_handle, PRESET_PLUGINS_FILE)
}

/// 旧版内置插件资源目录名。作为查找回退保留（已装旧布局插件的自愈仍能命中），
/// 同时由 [`remove_legacy_bundled_plugins`] 在启动时清理升级残留的整目录副本。
const BUNDLED_PLUGINS_DIR: &str = "internal-plugins";
/// 旧版预装插件资源目录名，仅用于启动迁移清理
const LEGACY_BUNDLED_PLUGINS_DIR: &str = "preset-plugins";

/// 在资源根目录下定位某内置插件：pnpm deploy 将包放在 `node_modules/<name>`，
/// 旧版 `internal-plugins/<id>` 布局仅作为兼容回退。
fn find_bundled_in_root(root: &std::path::Path, id: &str) -> Option<PathBuf> {
    let probe = |base: &std::path::Path| {
        let resources = base.join("resources");
        let deployed = resources.join("node_modules").join(id);
        if deployed.join("package.json").exists() {
            return Some(deployed);
        }
        let legacy = resources.join(BUNDLED_PLUGINS_DIR).join(id);
        if legacy.join("package.json").exists() {
            return Some(legacy);
        }
        let flat_legacy = base.join(BUNDLED_PLUGINS_DIR).join(id);
        flat_legacy
            .join("package.json")
            .exists()
            .then_some(flat_legacy)
    };
    probe(root).or_else(|| {
        let deployed = root.join("node_modules").join(id);
        deployed.join("package.json").exists().then_some(deployed)
    })
}

/// 定位内置插件捆绑目录：debug 优先命中仓库根 `packages/*` 源码目录；
/// release/兜底按 `resources/node_modules/<name>`（构建期 `pnpm deploy` 产物）查找，
/// 旧版 `resources/internal-plugins/<id>` 仅作兼容回退。
///
/// 用于安装（`install.rs` 生成 `link:` 依赖）与启动自愈（`internal.rs` 核对路径）。
///
/// **开发覆盖（仅 debug 构建）**：仓库根 `packages/*` 中非私有且含 `dsh` 对象的
/// 包自动成为内置插件，本函数对 id 命中即返回其源码目录 `packages/<dir>`——pnpm
/// `link:` 依赖是目录联接（junction），改源码 + 重启服务即热更新，无需提交子插件
/// git、无需构建期打包；仓库里不存在该 id 时回落随包目录，让开发与发布共用一套
/// 兜底逻辑。
pub(crate) fn bundled_plugin_dir(app_handle: &AppHandle, id: &str) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = dev_plugin_dir(id) {
        return Some(dir);
    }
    if let Ok(dir) = app_handle.path().resource_dir() {
        if let Some(candidate) = find_bundled_in_root(&dir, id) {
            return Some(candidate);
        }
    }
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let deployed = resources.join("node_modules").join(id);
    if deployed.join("package.json").exists() {
        return Some(deployed);
    }
    let legacy = resources.join(BUNDLED_PLUGINS_DIR).join(id);
    legacy.join("package.json").exists().then_some(legacy)
}

/// 删除旧版随包资源目录 `resources/preset-plugins` 与 `resources/internal-plugins`，
/// 避免升级安装保留不再使用/已迁至 `resources/node_modules/<name>` 的内置插件副本。
/// 仅处理 Tauri 运行时资源根下的目录，绝不删除源码 checkout；逐个尝试所有布局后
/// 再汇总错误，避免一个被占用的旧目录阻碍其余目录清理。
pub(crate) fn remove_legacy_bundled_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let Ok(root) = app_handle.path().resource_dir() else {
        return Ok(());
    };
    let candidates = vec![
        root.join(LEGACY_BUNDLED_PLUGINS_DIR),
        root.join("resources").join(LEGACY_BUNDLED_PLUGINS_DIR),
        root.join(BUNDLED_PLUGINS_DIR),
        root.join("resources").join(BUNDLED_PLUGINS_DIR),
    ];
    // resource_dir() 在不同平台可能返回安装根或 resources 根；若 root 本身即
    // resources，则上面的 `root/resources` 会误拼一个不存在的嵌套资源根，这里
    // 只删真正存在且含旧布局的目录（remove_legacy_candidates 本身也会跳过
    // 不存在的目录）。
    remove_legacy_candidates(candidates, |path| std::fs::remove_dir_all(path))
}

/// 对候选旧目录执行最佳努力清理；删除动作参数化是为了验证单项失败后仍继续处理。
fn remove_legacy_candidates(
    mut candidates: Vec<PathBuf>,
    mut remove: impl FnMut(&std::path::Path) -> std::io::Result<()>,
) -> Result<(), String> {
    candidates.sort();
    candidates.dedup();
    let mut failures = Vec::new();

    for path in candidates {
        if !path.is_dir() {
            continue;
        }
        match remove(&path) {
            Ok(()) => {
                log::info!(
                    "removed legacy bundled plugins directory: {}",
                    path.display()
                );
            }
            Err(e) => failures.push(format!(
                "LEGACY_PRESET_PLUGINS_REMOVE_FAILED: {}: {e}",
                path.display()
            )),
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// 内置插件的安装依赖形式：`link:<绝对路径>`（正斜杠、去尾部斜杠）。
///
/// 用 `link:` 而非 `file:`：pnpm 会把 `file:D:/...`（Windows 盘符冒号）当相对
/// 路径拼到 cwd 下（报 `scandir <cwd>\D:\... ENOENT`），而 `link:` 正确按绝对
/// 路径解析并建立目录联接（junction，改源码重启服务即热更新）。pnpm 按传入
/// 形式把 `link:` 依赖写入 profile 的 package.json；安装（`install.rs`）与启动
/// 自愈（`internal.rs`）共用这一规范形比对路径是否正确。
///
/// 生成前用 `dunce::simplified` 归一化 Windows 扩展长度路径前缀（`\\?\`
/// verbatim）：`resource_dir()` 在部分 Windows 环境返回 verbatim 形式，直接
/// 拼进 `link:` 会得到 `link://?/G:/...`，pnpm 会把 `//?/G:/...` 当作相对路径
/// 解析并生成 `..\?\G:\...` 的坏联接（内置插件重装死循环的根因），因此此处
/// 统一转成常规绝对路径。dunce 在非 Windows 平台是 no-op，跨平台安全。
pub(crate) fn bundled_dep_spec(dir: &std::path::Path) -> String {
    let normalized = dunce::simplified(dir).to_string_lossy().replace('\\', "/");
    format!("link:{}", normalized.trim_end_matches('/'))
}

/// 解析插件清单 JSON，并由清单来源统一设置内部插件标记。
///
/// 清单边界是可信的产品分类：即使条目误带或遗漏 `internal` 字段，也不能让社区
/// 预设获得必装自愈权限，或让内部插件退出自愈流程，因此始终以文件来源覆盖该值。
fn parse_plugins(json: &str, internal: bool) -> Result<Vec<PreinstallPluginInfo>, String> {
    let mut plugins: Vec<PreinstallPluginInfo> =
        serde_json::from_str(json).map_err(|e| format!("PLUGIN_MANIFEST_INVALID_JSON: {e}"))?;
    for plugin in &mut plugins {
        plugin.internal = internal;
    }
    Ok(plugins)
}

/// 读取单个插件清单；资源缺失/损坏时记录错误并返回空清单。
///
/// 插件元数据不是桌面壳启动的硬依赖；降级为空列表可让核心服务继续启动，同时用
/// 明确日志保留发布资源缺失或损坏的诊断信息，避免清单故障导致应用整体不可用。
fn load_manifest(
    app_handle: &AppHandle,
    file_name: &str,
    internal: bool,
) -> Vec<PreinstallPluginInfo> {
    let Some(path) = plugins_manifest_path(app_handle, file_name) else {
        log::warn!("PLUGIN_MANIFEST_MISSING: {file_name} not found in resource dir or source resources dir");
        return Vec::new();
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::error!("PLUGIN_MANIFEST_READ_FAILED: {}: {e}", path.display());
            return Vec::new();
        }
    };

    parse_plugins(&raw, internal).unwrap_or_else(|e| {
        log::error!("PLUGIN_MANIFEST_PARSE_FAILED: {}: {e}", path.display());
        Vec::new()
    })
}

/// 读取预设与内部插件清单并合并；内部属性由文件归属决定，不依赖 JSON 字段。
///
/// **开发覆盖（仅 debug 构建）**：仓库根 `packages/*` 中非私有且含 `dsh` 对象的
/// workspace 包会按 id 覆盖静态内部清单条目，未登记的新插件一并追加，因此开发时
/// 观察到的内置插件集合以仓库源码为准，与 release（只认随包清单）逻辑一致。
pub(crate) fn load_presets(app_handle: &AppHandle) -> Vec<PreinstallPluginInfo> {
    let mut plugins = load_manifest(app_handle, PRESET_PLUGINS_FILE, false);
    let internal = load_manifest(app_handle, INTERNAL_PLUGINS_FILE, true);
    #[cfg(debug_assertions)]
    let internal = merge_dev_internal_plugins(internal);
    plugins.extend(internal);
    plugins
}

/// 解析弃用插件清单 JSON（纯字符串数组），返回 id 集合（重复 id 自动去重）。
fn parse_deprecated_ids(json: &str) -> Result<HashSet<String>, String> {
    let ids: Vec<String> = serde_json::from_str(json)
        .map_err(|e| format!("DEPRECATED_PLUGINS_MANIFEST_INVALID_JSON: {e}"))?;
    Ok(ids.into_iter().collect())
}

/// 读取弃用插件清单（`resources/deprecated-plugins.json`），返回已登记的预设
/// 插件 id 集合。
///
/// 弃用是发布侧决策：某社区插件下架/被替换后，把它的 id 追加进该文件，桌面端
/// 每次启动核对「已安装 → 自动卸载」（见
/// [`super::install::uninstall_deprecated_plugins`]）。与 `preset-plugins.json`
/// 分开维护：预设清单只描述「可安装项」，弃用清单只描述「不再提供安装入口的
/// 预设 id」，调整弃用名单不会让既有用户重新进入首次引导。资源缺失/损坏时
/// 记录错误并回落为空集合，不阻断启动（与其它清单同一降级策略）。
pub(crate) fn load_deprecated_ids(app_handle: &AppHandle) -> HashSet<String> {
    let Some(path) = plugins_manifest_path(app_handle, DEPRECATED_PLUGINS_FILE) else {
        log::warn!("DEPRECATED_PLUGINS_MANIFEST_MISSING: {DEPRECATED_PLUGINS_FILE} not found in resource dir or source resources dir");
        return HashSet::new();
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            log::error!(
                "DEPRECATED_PLUGINS_MANIFEST_READ_FAILED: {}: {e}",
                path.display()
            );
            return HashSet::new();
        }
    };
    parse_deprecated_ids(&raw).unwrap_or_else(|e| {
        log::error!(
            "DEPRECATED_PLUGINS_MANIFEST_PARSE_FAILED: {}: {e}",
            path.display()
        );
        HashSet::new()
    })
}

/// 预装清单中某 id 对应的仓库地址
pub fn repo_url_of(app_handle: &AppHandle, id: &str) -> Option<String> {
    load_presets(app_handle)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.repo_url)
}

/// FNV-1a 64 位哈希（无外部依赖，跨平台稳定）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// 当前 `preset-plugins.json` 内容指纹（十六进制 FNV-1a）；文件缺失/不可读返回 None
pub(crate) fn current_preset_hash(app_handle: &AppHandle) -> Option<String> {
    let path = preset_plugins_path(app_handle)?;
    let raw = std::fs::read(&path).ok()?;
    Some(format!("{:016x}", fnv1a(&raw)))
}

/// 是否需要进入预装插件引导：
/// - 引导从未完成（首启/中途退出）→ 需要
/// - 老用户升级无指纹基线（文件在）→ 弹一次建立基线
/// - 有基线且内容已变更 → 需要
/// - 文件缺失视为无变化，避免每次启动都弹空引导
pub(crate) fn preinstall_pending(app_handle: &AppHandle) -> bool {
    let setting = config::get_store_dat_setting(app_handle);
    if !setting.preinstall_done {
        return true;
    }
    match (
        setting.preset_hash.as_deref(),
        current_preset_hash(app_handle),
    ) {
        (None, Some(_)) => true,
        (Some(prev), Some(cur)) => prev != cur,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_manifest_for_test(file_name: &str, internal: bool) -> Vec<PreinstallPluginInfo> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(file_name);
        let raw = std::fs::read_to_string(path).expect("plugin manifest should exist");
        parse_plugins(&raw, internal).expect("plugin manifest should be valid JSON")
    }

    fn load_presets_for_test() -> Vec<PreinstallPluginInfo> {
        load_manifest_for_test(PRESET_PLUGINS_FILE, false)
    }

    fn load_all_plugins_for_test() -> Vec<PreinstallPluginInfo> {
        let mut plugins = load_presets_for_test();
        plugins.extend(load_manifest_for_test(INTERNAL_PLUGINS_FILE, true));
        plugins
    }

    #[test]
    fn preset_list_contains_dshmarket() {
        let presets = load_presets_for_test();
        assert!(presets.iter().any(|p| p.id == "dshmarket"));
        assert_eq!(
            presets
                .iter()
                .find(|p| p.id == "dshmarket")
                .map(|p| p.repo_url.as_str()),
            Some("https://github.com/dsh-market/dsh-market")
        );
        assert!(!presets.iter().any(|p| p.id == "unknown-package"));
    }

    #[test]
    fn plugin_manifest_ids_are_unique_across_files() {
        let plugins = load_all_plugins_for_test();
        let ids: std::collections::HashSet<&str> = plugins.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids.len(),
            plugins.len(),
            "plugin ids must be unique across manifests"
        );
    }

    #[test]
    fn internal_manifest_marks_all_entries_internal() {
        let plugins = load_manifest_for_test(INTERNAL_PLUGINS_FILE, true);
        assert!(!plugins.is_empty());
        assert!(plugins.iter().all(|plugin| plugin.internal));
        assert!(plugins.iter().any(|plugin| plugin.id == "dsh-tauri"));
        assert!(!load_presets_for_test().iter().any(|plugin| plugin.internal));
    }

    #[test]
    fn preset_discovery_finds_nested_resources_dir() {
        // 回归：Windows 安装包（NSIS/MSI）与开发产物把资源按 `resources/**` 前缀
        // 落盘到 `{resource_dir}/resources/` 子目录，此前只探测 exe 同级导致
        // 发布版预装页恒为空清单。
        let dir = std::env::temp_dir().join(format!("dsh-preset-layout-{}", std::process::id()));
        let nested = dir.join("resources");
        std::fs::create_dir_all(&nested).expect("create temp resources dir");
        std::fs::write(
            nested.join(PRESET_PLUGINS_FILE),
            r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#,
        )
        .expect("write temp preset file");

        let found = find_manifest_in_resource_root(&dir, PRESET_PLUGINS_FILE)
            .expect("nested resources layout should be found");
        assert_eq!(found, nested.join(PRESET_PLUGINS_FILE));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preset_discovery_prefers_flat_layout() {
        // 扁平布局（资源直接放在 exe 同级）仍应优先命中。
        let dir = std::env::temp_dir().join(format!("dsh-preset-flat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(
            dir.join(PRESET_PLUGINS_FILE),
            r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#,
        )
        .expect("write temp preset file");

        let found = find_manifest_in_resource_root(&dir, PRESET_PLUGINS_FILE)
            .expect("flat layout should be found");
        assert_eq!(found, dir.join(PRESET_PLUGINS_FILE));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deprecated_ids_parse_into_set() {
        // 字符串数组解析为 id 集合；重复 id 去重
        let raw = r#"["dsh-a","dsh-b","dsh-a"]"#;
        let ids = parse_deprecated_ids(raw).expect("deprecated manifest should parse");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("dsh-a"));
        assert!(ids.contains("dsh-b"));
    }

    #[test]
    fn deprecated_ids_reject_non_string_entries() {
        // 非法条目（非字符串）整体解析失败，调用方回落为空集合
        let raw = r#"[42]"#;
        assert!(parse_deprecated_ids(raw).is_err());
        let raw = r#"{"id":"dsh-x"}"#;
        assert!(parse_deprecated_ids(raw).is_err());
    }

    #[test]
    fn deprecated_manifest_lists_session_context_menu() {
        // 随包分发的弃用清单应登记 dsh-session-context-menu（已被内部插件替代）
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(DEPRECATED_PLUGINS_FILE);
        let raw = std::fs::read_to_string(path).expect("deprecated manifest should exist");
        let ids = parse_deprecated_ids(&raw).expect("deprecated manifest should be valid JSON");
        assert!(ids.contains("dsh-session-context-menu"));
    }

    #[test]
    fn manifest_source_overrides_internal_field() {
        let raw =
            r#"[{"id":"x","spec":"y","internal":true,"name":"X","description":"","repoUrl":"u"}]"#;
        let preset = parse_plugins(raw, false).expect("preset manifest should parse");
        assert!(!preset[0].internal);
        let internal = parse_plugins(raw, true).expect("internal manifest should parse");
        assert!(internal[0].internal);
    }

    #[test]
    fn legacy_cleanup_continues_after_failure_and_aggregates_errors() {
        let root = std::env::temp_dir().join(format!("dsh-legacy-cleanup-{}", std::process::id()));
        let first = root.join("a");
        let second = root.join("b");
        std::fs::create_dir_all(&first).expect("create first legacy dir");
        std::fs::create_dir_all(&second).expect("create second legacy dir");
        let mut attempted = Vec::new();

        let error = remove_legacy_candidates(vec![first.clone(), second.clone()], |path| {
            attempted.push(path.to_path_buf());
            if path == first {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "locked",
                ))
            } else {
                std::fs::remove_dir_all(path)
            }
        })
        .expect_err("one failed cleanup should be reported");

        assert_eq!(attempted, vec![first.clone(), second.clone()]);
        assert!(error.contains("LEGACY_PRESET_PLUGINS_REMOVE_FAILED"));
        assert!(error.contains(&first.display().to_string()));
        assert!(error.contains("locked"));
        assert!(first.is_dir());
        assert!(!second.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bundled_dir_discovers_nested_layout() {
        // 兼容布局：{root}/resources/internal-plugins/<id>（旧版捆绑目录）仍应命中
        let dir = std::env::temp_dir().join(format!("dsh-bundled-nested-{}", std::process::id()));
        let nested = dir
            .join("resources")
            .join(BUNDLED_PLUGINS_DIR)
            .join("dsh-tauri");
        std::fs::create_dir_all(&nested).expect("create temp nested bundled dir");
        std::fs::write(nested.join("package.json"), "{}").expect("write bundle manifest");

        let found =
            find_bundled_in_root(&dir, "dsh-tauri").expect("nested bundled dir should be found");
        assert_eq!(found, nested);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundled_dir_discovers_flat_layout() {
        let dir = std::env::temp_dir().join(format!("dsh-bundled-flat-{}", std::process::id()));
        let flat = dir.join(BUNDLED_PLUGINS_DIR).join("dsh-tauri");
        std::fs::create_dir_all(&flat).expect("create temp flat bundled dir");
        std::fs::write(flat.join("package.json"), "{}").expect("write bundle manifest");

        let found =
            find_bundled_in_root(&dir, "dsh-tauri").expect("flat bundled dir should be found");
        assert_eq!(found, flat);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundled_dir_requires_package_json() {
        // 无 package.json 的目录不是有效产物（build:plugins 未执行）
        let dir = std::env::temp_dir().join(format!("dsh-bundled-empty-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(BUNDLED_PLUGINS_DIR).join("dsh-tauri"))
            .expect("create empty dir");
        assert!(find_bundled_in_root(&dir, "dsh-tauri").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundled_dep_spec_normalizes_windows_separators() {
        assert_eq!(
            bundled_dep_spec(std::path::Path::new(
                "C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri"
            )),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
        // 尾部斜杠去除（Windows 盘符 C:\ 不会出现，路径恒为子目录）
        assert_eq!(
            bundled_dep_spec(std::path::Path::new("/opt/dsh/plugins/x/")),
            "link:/opt/dsh/plugins/x"
        );
    }

    #[cfg(windows)]
    #[test]
    fn bundled_dep_spec_strips_verbatim_prefix() {
        // 回归：Windows 扩展长度路径前缀（`\\?\`）不该进入 link: spec。
        // `resource_dir()` 返回 verbatim 路径时，未剥离会导致 pnpm 把
        // `//?/G:/...` 当相对路径解析、生成 `..\?\G:\...` 的坏联接而安装失败。
        // （dunce::simplified 在 Windows 上把 `\\?\` 归一回常规绝对路径）
        let dir = std::path::Path::new(
            r"\\?\G:\Deepseek Harness Desktop\resources\internal-plugins\dsh-tauri",
        );
        assert_eq!(
            bundled_dep_spec(dir),
            "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri"
        );
    }

    #[test]
    fn fnv1a_matches_known_vectors() {
        // FNV-1a 64-bit 标准测试向量
        assert_eq!(fnv1a(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a(b"a"), 0xaf63dc4c8601ec8c);
        assert_eq!(fnv1a(b"foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn same_content_same_hash_appended_comma_changes_hash() {
        let a = r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"}]"#;
        let b = r#"[{"id":"x","spec":"y","name":"X","description":"","repoUrl":"u"},]"#;
        assert_eq!(fnv1a(a.as_bytes()), fnv1a(a.as_bytes()));
        assert_ne!(fnv1a(a.as_bytes()), fnv1a(b.as_bytes()));
    }

    #[test]
    fn pending_decision_matrix() {
        // 未完成引导 → 一定需要
        assert!(preinstall_pending_for_test(false, None, Some("h1")));
        assert!(preinstall_pending_for_test(false, Some("h1"), Some("h1")));
        // 老用户升级：无基线且文件在 → 弹一次建立基线
        assert!(preinstall_pending_for_test(true, None, Some("h1")));
        // 基线一致 → 不弹
        assert!(!preinstall_pending_for_test(true, Some("h1"), Some("h1")));
        // 内容变更 → 弹
        assert!(preinstall_pending_for_test(true, Some("h1"), Some("h2")));
        // 文件缺失：视为无变化不弹（有基线或老用户都不弹）
        assert!(!preinstall_pending_for_test(true, Some("h1"), None));
        assert!(!preinstall_pending_for_test(true, None, None));
    }

    /// 纯函数版 pending 判定（便于单测，不依赖 AppHandle）
    fn preinstall_pending_for_test(
        preinstall_done: bool,
        recorded: Option<&str>,
        current: Option<&str>,
    ) -> bool {
        if !preinstall_done {
            return true;
        }
        match (recorded, current) {
            (None, Some(_)) => true,
            (Some(prev), Some(cur)) => prev != cur,
            _ => false,
        }
    }

    /// 写入一个带 `dsh` 对象的开发包 manifest。
    #[cfg(debug_assertions)]
    fn write_dev_manifest(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).expect("create dev package dir");
        let manifest = serde_json::json!({
            "name": name,
            "description": "desc",
            "dsh": {"client": {"inject": ["x"]}},
        });
        std::fs::write(
            dir.join("package.json"),
            serde_json::to_string(&manifest).expect("serialize dev manifest"),
        )
        .expect("write dev manifest");
    }

    #[cfg(debug_assertions)]
    fn temp_dev_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dsh-dev-{label}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).expect("create temp dev root");
        root
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_empty_root_returns_none() {
        let root = temp_dev_root("empty");
        assert!(discover_dev_internal_plugins_at(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_skips_invalid_manifest() {
        let root = temp_dev_root("invalid");
        let dir = root.join("bad");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(dir.join("package.json"), "{ not json").expect("write bad manifest");
        assert!(discover_dev_internal_plugins_at(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_skips_when_missing_or_invalid_dsh_value() {
        let root = temp_dev_root("dsh");
        // 无 dsh 字段
        std::fs::create_dir_all(root.join("no-dsh")).expect("create dir");
        std::fs::write(
            root.join("no-dsh").join("package.json"),
            r#"{"name":"no-dsh","description":"x"}"#,
        )
        .expect("write manifest");
        // dsh 非对象：字符串 / 数组 / null
        for (name, dsh) in [
            ("str-dsh", r#""x""#),
            ("arr-dsh", "[]"),
            ("null-dsh", "null"),
        ] {
            std::fs::create_dir_all(root.join(name)).expect("create dir");
            std::fs::write(
                root.join(name).join("package.json"),
                format!(r#"{{"name":"{name}","dsh":{dsh}}}"#),
            )
            .expect("write manifest");
        }
        assert!(discover_dev_internal_plugins_at(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_skips_private_manifest() {
        let root = temp_dev_root("private");
        // private: true 的包（bundler / 工具包 / 演示占位插件）即使含 dsh 也忽略
        std::fs::create_dir_all(root.join("placeholder")).expect("create dir");
        std::fs::write(
            root.join("placeholder").join("package.json"),
            r#"{"name":"placeholder","private":true,"dsh":{"client":{"inject":["x"]}}}"#,
        )
        .expect("write manifest");
        assert!(discover_dev_internal_plugins_at(&root).is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_discovers_real_package_name_regardless_of_dirname() {
        let root = temp_dev_root("name");
        // 目录名与真实 npm 包名不同：id/依赖键以 package.name 为准
        write_dev_manifest(&root.join("some-dir"), "@scope/dsh-plugin");
        let found = discover_dev_internal_plugins_at(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].info.id, "@scope/dsh-plugin");
        assert_eq!(found[0].info.spec, "@scope/dsh-plugin");
        assert_eq!(found[0].info.package.as_deref(), Some("@scope/dsh-plugin"));
        assert!(found[0].info.internal);
        assert!(found[0].directory.ends_with("some-dir"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_dedups_by_package_name() {
        let root = temp_dev_root("dedup");
        // 两个目录声明同名包：后者被跳过（DEV_INTERNAL_PLUGIN_DUPLICATE）
        write_dev_manifest(&root.join("a"), "dsh-tauri");
        write_dev_manifest(&root.join("b"), "dsh-tauri");
        let found = discover_dev_internal_plugins_at(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].info.id, "dsh-tauri");
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_sorts_by_directory_name() {
        let root = temp_dev_root("sort");
        write_dev_manifest(&root.join("b-plugin"), "b");
        write_dev_manifest(&root.join("a-plugin"), "a");
        let found = discover_dev_internal_plugins_at(&root);
        let ids: Vec<&str> = found.iter().map(|c| c.info.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_sets_repo_url_from_repository_object() {
        let root = temp_dev_root("repo");
        let dir = root.join("repo-plugin");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"repo-plugin","repository":{"url":"git+https://github.com/x/repo.git"},"dsh":{"client":{"inject":["x"]}}}"#,
        )
        .expect("write manifest");
        let found = discover_dev_internal_plugins_at(&root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].info.repo_url, "https://github.com/x/repo");
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_discovery_merge_overrides_static_entry_and_appends_new() {
        let root = temp_dev_root("merge");
        // 静态清单：dsh-tauri（待被 dev 覆盖） + 缺失 dev 的 keep-static
        // dev 候选：dsh-tauri（覆盖） + brand-new（追加）
        write_dev_manifest(&root.join("dsh-tauri"), "dsh-tauri");
        write_dev_manifest(&root.join("brand-new"), "brand-new");
        let static_internal = vec![
            PreinstallPluginInfo {
                id: "dsh-tauri".into(),
                spec: "dsh-tauri".into(),
                internal: true,
                package: Some("dsh-tauri".into()),
                name: "dsh-tauri".into(),
                description: "static desc".into(),
                repo_url: "static".into(),
                recommended: false,
                fix: false,
                default_checked: false,
                win_only: false,
            },
            PreinstallPluginInfo {
                id: "keep-static".into(),
                spec: "keep-static".into(),
                internal: true,
                package: Some("keep-static".into()),
                name: "keep-static".into(),
                description: String::new(),
                repo_url: String::new(),
                recommended: false,
                fix: false,
                default_checked: false,
                win_only: false,
            },
        ];
        // 把 dev 扫描根临时指向临时目录，借助 discover 函数合并
        let merged = merge_dev_internal_plugins_at(&root, static_internal);
        let ids: std::collections::HashSet<&str> = merged.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        let dsh = merged.iter().find(|p| p.id == "dsh-tauri").unwrap();
        assert_eq!(dsh.description, "desc"); // dev 覆盖静态
        assert!(merged.iter().any(|p| p.id == "brand-new")); // 追加上去
        assert!(merged.iter().any(|p| p.id == "keep-static")); // 静态未覆盖项保留
        std::fs::remove_dir_all(&root).ok();
    }
}
