//! 插件清单：分别读取随安装包分发的 `resources/preset-plugins.json` 与
//! `resources/internal-plugins.json`。
//!
//! 社区预设与内部插件分开维护；运行时合并为统一结构供安装、展示与自愈逻辑使用。
//! 资源缺失/损坏时报错并回落为空清单，不阻断启动。

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::config;

/// 预设插件清单文件名
const PRESET_PLUGINS_FILE: &str = "preset-plugins.json";
/// 内部插件清单文件名
const INTERNAL_PLUGINS_FILE: &str = "internal-plugins.json";

/// 插件静态信息，对应预设或内部插件清单中的条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallPluginInfo {
    /// 前端主键 / 仓库跳转查找键
    pub id: String,
    /// 传给 `dsh plugin add` 的依赖形式（npm 包名或 git 依赖形式）
    pub spec: String,
    /// 内置插件：条目来自 `resources/internal-plugins.json`，产物由构建期
    /// `scripts/prebuild.ts` 从上游仓库拉取到 `resources/internal-plugins/<id>/`
    /// 随安装包分发，安装固定走 `link:` 本地
    /// 依赖；启动时强制核对「已安装 + 路径指向当前捆绑目录」，不满足即自动
    /// 重装（用户卸载后重启应用同样恢复），因此不出现在首次引导的勾选清单里。
    #[serde(default)]
    pub internal: bool,
    /// 安装进 profile 后实际出现在 `dependencies`/`bundles` 里的包名。
    /// 默认与 `id` 相同；仅当 npm 包名与预设 id 不一致时（如 scoped 包
    /// `@scope/name`）才需要显式指定，供“已安装”检测使用。
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

/// 内置插件资源目录名（相对资源根的固定前缀）
const BUNDLED_PLUGINS_DIR: &str = "internal-plugins";
/// 旧版内置插件资源目录名，仅用于启动迁移清理
const LEGACY_BUNDLED_PLUGINS_DIR: &str = "preset-plugins";

/// 在资源根目录下定位某内置插件的捆绑目录：与 [`find_manifest_in_resource_root`] 相同的
/// 布局探测——先 `resources/` 子目录（安装包/开发产物按 `bundle.resources` 前缀
/// 落盘），再扁平布局；以目录内存在 `package.json` 判定产物有效（prebuild 恒写入）。
fn find_bundled_in_root(root: &std::path::Path, id: &str) -> Option<PathBuf> {
    let probe = |base: &std::path::Path| {
        let dir = base.join(BUNDLED_PLUGINS_DIR).join(id);
        dir.join("package.json").exists().then_some(dir)
    };
    probe(&root.join("resources")).or_else(|| probe(root))
}

/// 定位内置插件捆绑目录：优先随安装包分发的资源目录，回落到源码
/// `resources/internal-plugins/<id>`（开发机未跑 prebuild 时作为源码兜底）。
///
/// 用于安装（`install.rs` 生成 `file:` 依赖）与启动自愈（`internal.rs` 核对路径）。
///
/// **开发覆盖（仅 debug 构建）**：仓库根 `.env` 声明 `DEV_INTERNAL_PLUGINS_DIR=<dir>`
/// 时，`<dir>/<id>` 命中即以本地插件源码目录为安装目标——pnpm `file:` 依赖是
/// junction（目录联接），改源码 + 重启服务即热更新，无需提交子插件 git、无需
/// prebuild；设置但缺该 id 返回 None（跳过，不回落随包目录），让开发者显式感知。
pub(crate) fn bundled_plugin_dir(app_handle: &AppHandle, id: &str) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(root) = dev_internal_plugins_dir() {
        let dev = root.join(id);
        return dev.join("package.json").exists().then_some(dev);
    }
    if let Ok(dir) = app_handle.path().resource_dir() {
        if let Some(candidate) = find_bundled_in_root(&dir, id) {
            return Some(candidate);
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BUNDLED_PLUGINS_DIR)
        .join(id);
    source.join("package.json").exists().then_some(source)
}

/// 删除旧版随包资源目录 `resources/preset-plugins`，避免升级安装保留不再使用的
/// 内部插件副本。仅处理 Tauri 运行时资源根下的目录，绝不删除源码 checkout；逐个
/// 尝试所有布局后再汇总错误，避免一个被占用的旧目录阻碍其余目录清理。
pub(crate) fn remove_legacy_bundled_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let Ok(root) = app_handle.path().resource_dir() else {
        return Ok(());
    };
    let candidates = vec![
        root.join(LEGACY_BUNDLED_PLUGINS_DIR),
        root.join("resources").join(LEGACY_BUNDLED_PLUGINS_DIR),
    ];
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

/// 开发模式内置插件源码根目录：读取 `<仓库根>/.env` 的 `DEV_INTERNAL_PLUGINS_DIR`。
/// 仅 debug 构建生效（release 恒用随包目录，不受构建机环境影响）。
///
/// `.env` 属于本地个人配置，不入库（见仓库 `.gitignore`）；`<仓库根>` 由编译期
/// `CARGO_MANIFEST_DIR`（即 `src-tauri`）的上层目录得到，只在开发机成立。
#[cfg(debug_assertions)]
fn dev_internal_plugins_dir() -> Option<PathBuf> {
    let env_file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(".env");
    let content = std::fs::read_to_string(env_file).ok()?;
    parse_dev_internal_dir(&content)
}

/// 从 `.env` 文本解析 `DEV_INTERNAL_PLUGINS_DIR`（纯函数，便于单测）：
/// 支持 `KEY=VALUE` / `KEY = VALUE`（键值两侧空白容忍）、值可选单/双引号包裹；
/// `#` 起始行与空行跳过；显式置空（`KEY=`）视为未设置；缺键返回 None。
#[cfg(debug_assertions)]
fn parse_dev_internal_dir(content: &str) -> Option<PathBuf> {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "DEV_INTERNAL_PLUGINS_DIR" {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            return None;
        }
        return Some(PathBuf::from(value));
    }
    None
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
pub(crate) fn load_presets(app_handle: &AppHandle) -> Vec<PreinstallPluginInfo> {
    let mut plugins = load_manifest(app_handle, PRESET_PLUGINS_FILE, false);
    plugins.extend(load_manifest(app_handle, INTERNAL_PLUGINS_FILE, true));
    plugins
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
        // 与 internal 文件一致：先探测 {root}/resources/internal-plugins/<id>
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
        // 无 package.json 的目录不是有效产物（prebuild 未执行）
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

    #[cfg(debug_assertions)]
    #[test]
    fn dev_internal_dir_parses_plain_and_quoted_values() {
        assert_eq!(
            parse_dev_internal_dir("DEV_INTERNAL_PLUGINS_DIR=C:/dev/plugins\n"),
            Some(PathBuf::from("C:/dev/plugins"))
        );
        // 键值两侧空白 + 引号包裹
        assert_eq!(
            parse_dev_internal_dir("DEV_INTERNAL_PLUGINS_DIR = \"C:/my plugins\"\n"),
            Some(PathBuf::from("C:/my plugins"))
        );
        assert_eq!(
            parse_dev_internal_dir("DEV_INTERNAL_PLUGINS_DIR='D:/dev/plugins'\r\n"),
            Some(PathBuf::from("D:/dev/plugins"))
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_internal_dir_skips_comment_and_other_keys() {
        let content = "# comment\n\nVITE_FOO=1\nDEV_INTERNAL_PLUGINS_DIR=E:/plugins\n";
        assert_eq!(
            parse_dev_internal_dir(content),
            Some(PathBuf::from("E:/plugins"))
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn dev_internal_dir_unset_when_missing_key_or_empty_value() {
        // 其它键或注释：视为未设置
        assert_eq!(parse_dev_internal_dir("FOO=bar\n"), None);
        assert_eq!(
            parse_dev_internal_dir("# DEV_INTERNAL_PLUGINS_DIR=C:/x\n"),
            None
        );
        // 显式置空：同样视为未设置（关闭覆盖）
        assert_eq!(parse_dev_internal_dir("DEV_INTERNAL_PLUGINS_DIR=\n"), None);
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
}
