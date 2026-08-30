//! 离线卸载（直接改 profile 清单）：从 manifest 移除依赖与 bundle 引用、
//! 删除 `node_modules/<id>` 入口（含 scoped 空目录清理与路径逃逸防护）、
//! 剥离 `cordis.patch.yml` 中目标插件的 patch 条目。

use std::fs;
#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;
use std::path::Path;

use crate::service::fs_guard;

/// 从 manifest 中移除指定插件（`dependencies` + `dsh.profile.bundles`），返回是否有改动。
pub(super) fn remove_plugin_from_manifest(manifest: &mut serde_json::Value, id: &str) -> bool {
    let mut modified = false;
    if let Some(deps) = manifest
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
    {
        if deps.remove(id).is_some() {
            modified = true;
        }
    }
    if let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|d| d.get_mut("profile"))
        .and_then(|p| p.get_mut("bundles"))
        .and_then(|b| b.as_array_mut())
    {
        let before = bundles.len();
        bundles.retain(|b| b.as_str() != Some(id));
        if bundles.len() != before {
            modified = true;
        }
    }
    modified
}

/// 删除插件入口：符号链接或 junction 只删除入口本身；普通目录递归删除，
/// 普通文件用 `remove_file`（`remove_dir_all` 对文件会报 ENOTDIR）。
fn remove_plugin_entry(entry: &Path) -> std::io::Result<()> {
    let file_type = fs::symlink_metadata(entry)?.file_type();
    #[cfg(windows)]
    if file_type.is_symlink_dir() {
        return fs::remove_dir(entry);
    }
    if file_type.is_symlink() {
        return fs::remove_file(entry);
    }
    if file_type.is_dir() {
        return fs::remove_dir_all(entry);
    }
    fs::remove_file(entry)
}

/// 删除 `node_modules/<id>`；scoped 目录删除后若 scope 空则一并清理。
pub(super) fn remove_plugin_dir(profile: &Path, id: &str) {
    let node_modules = profile.join("node_modules");
    let Ok(node_modules_root) = fs_guard::ensure_within(&node_modules, profile) else {
        log::warn!(
            "refusing to remove plugin from node_modules outside profile: {}",
            node_modules.display()
        );
        return;
    };
    let entry = node_modules.join(id);
    let Ok(entry_metadata) = fs::symlink_metadata(&entry) else {
        return;
    };
    let entry_is_dangling_symlink = entry_metadata.file_type().is_symlink() && !entry.exists();
    if entry_is_dangling_symlink {
        // 悬空链接无法规范化目标，只验证父目录，确保删除的仍是 node_modules 内入口。
        let Some(parent) = entry.parent() else {
            return;
        };
        if let Err(e) = fs_guard::ensure_within(parent, &node_modules_root) {
            log::warn!(
                "refusing to remove dangling plugin symlink outside node_modules: {} ({e})",
                entry.display()
            );
            return;
        }
    } else if let Err(e) = fs_guard::ensure_within(&entry, &node_modules_root) {
        log::warn!(
            "refusing to remove plugin outside node_modules: {} ({e})",
            entry.display()
        );
        return;
    }
    if let Err(e) = remove_plugin_entry(&entry) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!("failed to remove plugin dir {}: {e}", entry.display());
        }
    }
    if let Some(scope) = id
        .starts_with('@')
        .then(|| id.split('/').next().unwrap_or_default())
    {
        if !scope.is_empty() && scope != id {
            let scope_entry = node_modules.join(scope);
            if scope_entry.is_dir()
                && scope_entry
                    .read_dir()
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(false)
            {
                if fs_guard::ensure_within(&scope_entry, &node_modules_root).is_ok() {
                    let _ = remove_plugin_entry(&scope_entry);
                }
            }
        }
    }
}

/// 从 `cordis.patch.yml` 中剥离目标插件的 patch 条目（保留其它插件的 patch）。
///
/// 与 dsh-desktop「直接重置为 []」不同：这里只移除与目标插件相关的条目，不破坏
/// 其它插件的配置层，符合「其它插件不会被删除」的承诺。解析失败则原样保留。
pub(super) fn strip_cordis_patch_for(profile: &Path, id: &str) {
    let path = profile.join("cordis.patch.yml");
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(doc) = serde_yaml::from_str::<serde_yaml::Value>(&content) else {
        return;
    };
    let Some(entries) = doc.as_sequence() else {
        return;
    };
    let kept: Vec<serde_yaml::Value> = entries
        .iter()
        .filter(|e| !patch_entry_targets(e, id))
        .cloned()
        .collect();
    if kept.len() == entries.len() {
        return;
    }
    if let Ok(rendered) = serde_yaml::to_string(&serde_yaml::Value::Sequence(kept)) {
        let _ = fs::write(&path, rendered);
        log::info!("Stripped cordis.patch.yml entries for plugin {id}");
    }
}

/// 一个 patch 条目是否「针对」目标插件：顶层 id 字段或任意字段值等于该包名。
fn patch_entry_targets(entry: &serde_yaml::Value, id: &str) -> bool {
    match entry {
        serde_yaml::Value::Mapping(map) => map
            .iter()
            .any(|(k, v)| k.as_str() == Some(id) || v.as_str() == Some(id)),
        serde_yaml::Value::String(s) => s == id,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_plugin_dir_rejects_path_escape() {
        let root = std::env::temp_dir().join(format!("dsh-plugin-recovery-{}", std::process::id()));
        let profile = root.join("profile");
        std::fs::create_dir_all(profile.join("node_modules/foo")).unwrap();
        let outside = profile.join("target");
        std::fs::create_dir_all(&outside).unwrap();

        remove_plugin_dir(&profile, "foo/../../target");

        assert!(outside.exists(), "path traversal target must remain");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_plugin_dir_removes_valid_plugin() {
        let root =
            std::env::temp_dir().join(format!("dsh-plugin-recovery-valid-{}", std::process::id()));
        let profile = root.join("profile");
        let plugin = profile.join("node_modules/dsh-example");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("index.js"), "module.exports = {};").unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(!plugin.exists(), "valid plugin directory should be removed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_removes_symlink_without_target() {
        let root = std::env::temp_dir().join(format!(
            "dsh-plugin-recovery-pnpm-symlink-{}",
            std::process::id()
        ));
        let profile = root.join("profile");
        let link = profile.join("node_modules/dsh-example");
        let target = profile.join("node_modules/.pnpm/dsh-example@1/node_modules/dsh-example");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(target.exists(), "pnpm canonical target must remain");
        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "only the package symlink entry should be removed"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_removes_dangling_symlink() {
        let root = std::env::temp_dir().join(format!(
            "dsh-plugin-recovery-dangling-symlink-{}",
            std::process::id()
        ));
        let profile = root.join("profile");
        let link = profile.join("node_modules/dsh-example");
        let missing_target = profile.join("node_modules/.pnpm/missing/dsh-example");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&missing_target, &link).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "dangling plugin symlink entry should be removed"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_plugin_dir_rejects_node_modules_symlink_escape() {
        let root =
            std::env::temp_dir().join(format!("dsh-plugin-recovery-link-{}", std::process::id()));
        let profile = root.join("profile");
        let outside = root.join("outside-node-modules");
        let plugin = outside.join("dsh-example");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::create_dir_all(&plugin).unwrap();
        std::os::unix::fs::symlink(&outside, profile.join("node_modules")).unwrap();

        remove_plugin_dir(&profile, "dsh-example");

        assert!(plugin.exists(), "plugin outside profile must remain");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn remove_plugin_from_manifest_edits_deps_and_bundles() {
        let mut manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": { "dshmarker": "1.0.0", "dsh-better-sidebar": "1.0.0" },
            "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-better-sidebar"] } }
        });
        let modified = remove_plugin_from_manifest(&mut manifest, "dsh-better-sidebar");
        assert!(modified);
        assert!(manifest["dependencies"].get("dsh-better-sidebar").is_none());
        assert!(manifest["dependencies"].get("dshmarker").is_some());
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn patch_strip_targets_plugin_only() {
        let patch = serde_yaml::to_string(&serde_yaml::Value::Sequence(vec![
            serde_yaml::from_str::<serde_yaml::Value>("id: dsh-better-sidebar\nfoo: 1").unwrap(),
            serde_yaml::from_str::<serde_yaml::Value>("id: dsh-web-ui-all\nbar: 2").unwrap(),
        ]))
        .unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&patch).unwrap();
        let kept: Vec<serde_yaml::Value> = doc
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|e| !patch_entry_targets(e, "dsh-better-sidebar"))
            .cloned()
            .collect();
        assert_eq!(kept.len(), 1);
        let kept_doc = serde_yaml::to_string(&serde_yaml::Value::Sequence(kept)).unwrap();
        assert!(kept_doc.contains("dsh-web-ui-all"));
        assert!(!kept_doc.contains("dsh-better-sidebar"));
    }
}
