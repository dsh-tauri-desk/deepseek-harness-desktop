//! profile 清单与 `node_modules` 入口文件操作：内置插件就绪判定、待重装包声明
//! 的精准移除（保留其它插件）、原子写回清单与失效入口清理。

use std::collections::HashSet;
#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;
use std::path::Path;

/// 读取并解析入口清单，避免仅凭文件存在就把截断或不可读的内置插件视为健康。
pub(super) fn internal_plugin_entry_is_ready(entry: &Path) -> bool {
    let Ok(raw) = std::fs::read(entry.join("package.json")) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&raw).is_ok_and(|manifest| manifest.is_object())
}

/// 清理 profile bundle 列表中的重复引用，保留首次出现的顺序。
///
/// 旧工作目录切换期间，重复执行安装/迁移可能把同一个 bundle 追加多次；
/// Cordis 会把每个引用都展开，最终报 duplicate loader entry。只修改 bundle
/// 列表，不删除任何依赖或用户插件。
pub(super) fn dedupe_profile_bundles(manifest: &mut serde_json::Value) -> bool {
    let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|dsh| dsh.get_mut("profile"))
        .and_then(|profile| profile.get_mut("bundles"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        return false;
    };

    let before = bundles.len();
    let mut seen = HashSet::new();
    bundles.retain(|bundle| {
        bundle
            .as_str()
            .is_none_or(|name| seen.insert(name.to_string()))
    });
    bundles.len() != before
}

/// 从 profile 自身的 patch 层移除已经由 bundle 提供的重复 loader entry。
///
/// 旧版本从另一个桌面目录启动时，可能把插件的 `cordis.patch.yml` 内容复制到
/// profile patch；当前 bundle 又会再次提供同一 id。只移除顶层 `insert` 中与
/// bundle id 相同的条目，保留 win-terminal-inspector 等用户插件。
pub(super) fn remove_duplicate_bundle_entries_from_patch(
    patch: &mut serde_yaml::Value,
    bundle_ids: &HashSet<&str>,
) -> bool {
    let mut modified = false;
    remove_duplicate_inserted_entries(patch, bundle_ids, &mut modified);
    modified
}

/// 递归清理 patch 中的 insert，兼容旧版本写入的 group 嵌套结构。
fn remove_duplicate_inserted_entries(
    value: &mut serde_yaml::Value,
    bundle_ids: &HashSet<&str>,
    modified: &mut bool,
) {
    match value {
        serde_yaml::Value::Sequence(items) => {
            for item in items {
                remove_duplicate_inserted_entries(item, bundle_ids, modified);
            }
        }
        serde_yaml::Value::Mapping(mapping) => {
            if let Some(insert) = mapping
                .get_mut(serde_yaml::Value::String("insert".to_string()))
                .and_then(serde_yaml::Value::as_sequence_mut)
            {
                let before = insert.len();
                insert.retain(|item| {
                    item.get("id")
                        .and_then(serde_yaml::Value::as_str)
                        .is_none_or(|id| !bundle_ids.contains(id))
                });
                *modified |= insert.len() != before;
            }
            for child in mapping.values_mut() {
                remove_duplicate_inserted_entries(child, bundle_ids, modified);
            }
        }
        _ => {}
    }
}

/// 从 profile 清单精准移除待重装 internal 包的依赖与 bundle 引用。
pub(super) fn remove_internal_plugins_from_manifest(
    manifest: &mut serde_json::Value,
    names: &HashSet<&str>,
) -> bool {
    let mut modified = false;
    if let Some(dependencies) = manifest
        .get_mut("dependencies")
        .and_then(serde_json::Value::as_object_mut)
    {
        for name in names {
            modified |= dependencies.remove(*name).is_some();
        }
    }
    if let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|dsh| dsh.get_mut("profile"))
        .and_then(|profile| profile.get_mut("bundles"))
        .and_then(serde_json::Value::as_array_mut)
    {
        let before = bundles.len();
        bundles.retain(|bundle| bundle.as_str().is_none_or(|name| !names.contains(name)));
        modified |= bundles.len() != before;
    }
    modified
}

/// 经同目录临时文件原子替换 profile 清单，失败时保留原文件。
pub(super) fn write_profile_manifest(
    path: &Path,
    manifest: &serde_json::Value,
) -> Result<(), String> {
    use std::io::Write;

    let rendered = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("INTERNAL_PLUGIN_MANIFEST_RENDER_FAILED: {e}"))?;
    let temp = path.with_extension(format!("json.internal.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(format!("{rendered}\n").as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace_manifest_file(&temp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("INTERNAL_PLUGIN_MANIFEST_WRITE_FAILED: {e}"));
    }
    log::info!("Profile manifest rewritten: {}", path.display());
    Ok(())
}

#[cfg(not(windows))]
fn replace_manifest_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, path)
}

#[cfg(windows)]
fn replace_manifest_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temp_wide: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            path_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// 删除失效的插件入口，但绝不跟随符号链接 / junction 删除捆绑资源。
///
/// 正常目录只可能是 pnpm 留下的损坏产物，可以递归清理；Unix 符号链接与 Windows
/// junction 则只删除入口本身。入口不存在（包括已被并发清掉）视为幂等成功。
pub(super) fn remove_stale_plugin_entry(entry: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(entry) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let file_type = metadata.file_type();
    #[cfg(windows)]
    if file_type.is_symlink_dir() {
        return std::fs::remove_dir(entry);
    }
    if file_type.is_symlink() {
        return std::fs::remove_file(entry);
    }
    if file_type.is_dir() {
        return std::fs::remove_dir_all(entry);
    }
    std::fs::remove_file(entry)
}

/// 判断某依赖值是否为「本地目录链接」形式（`link:` / `file:`）。
///
/// 内置插件统一以 `link:<捆绑目录绝对路径>` 安装；`file:` 是协议切换前的历史遗留
/// 同义形式。用于启动自愈：当捆绑目录已不存在（如 debug 下切换 git 分支、某内置
/// 插件源码目录消失）时，只有 `link:`/`file:` 依赖才意味着「这是我们装的本地链接」，
/// 可以把悬空引用卸载；registry/git 引用（如 `dsh-tauri@0.2.0`、`github:x/y`）是用户
/// 独立安装，绝不能误卸。路径值不做存在性判断，只判前缀。
pub(super) fn is_local_link_dep(spec: &str) -> bool {
    spec.starts_with("link:") || spec.starts_with("file:")
}

/// 判断 pnpm 写入 profile 的依赖值与期望的 `link:` 捆绑路径是否一致。
///
/// 容忍：`link:`/`file:` 前缀缺失或两者混写（历史遗留 `file:` 安装值）；Windows
/// 下路径大小写不敏感；尾部斜杠差异（pnpm 各版本落盘形式略有出入）。
pub(super) fn dep_matches_spec(actual: &str, expected: &str) -> bool {
    let norm = |spec: &str| {
        let stripped = spec
            .strip_prefix("link:")
            .or_else(|| spec.strip_prefix("file:"))
            .unwrap_or(spec);
        // 统一用 dunce 归一化 Windows 扩展长度路径前缀（`\\?\`）：
        // 期望值已经由 bundled_dep_spec 归一化掉前缀；若历史命中的实值仍带
        // `//?/` / `\\?\` 前缀，先归一再比对，保证幂等（避免旧值一次次触发
        // 不必要的重装）。先把手写正斜杠的 verbatim 形式（`//?/`）换算成反斜杠
        // （dunce 依赖 `\\?\` 识别 verbatim），再交给 dunce::simplified，最后
        // 统一回正斜杠，与 bundled_dep_spec 的产出可比。
        let backslash = stripped.replace('/', "\\");
        dunce::simplified(Path::new(&backslash))
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    let actual = norm(actual);
    let expected = norm(expected);
    if cfg!(windows) {
        actual.eq_ignore_ascii_case(&expected)
    } else {
        actual == expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_plugin_entry_requires_readable_manifest_object() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-entry-readiness-{}",
            std::process::id()
        ));
        let manifest = root.join("package.json");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, br#"{"name":"dsh-tauri"}"#).unwrap();
        assert!(internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, br#"{"name":"dsh-tauri""#).unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, b"[]").unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        std::fs::write(&manifest, [0xff, 0xfe, 0xfd]).unwrap();
        assert!(!internal_plugin_entry_is_ready(&root));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_profile_bundles_are_removed_without_reordering() {
        let mut manifest = serde_json::json!({
            "dsh": { "profile": { "bundles": ["dsh-tauri", "dshmarket", "dsh-tauri", "dshmarket"] } }
        });

        assert!(dedupe_profile_bundles(&mut manifest));
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["dsh-tauri", "dshmarket"])
        );
        assert!(!dedupe_profile_bundles(&mut manifest));
    }

    #[test]
    fn stale_internal_manifest_entries_are_removed_without_touching_other_plugins() {
        let mut manifest = serde_json::json!({
            "private": true,
            "dependencies": {
                "dsh-tauri": "file:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/preset-plugins/dsh-tauri",
                "dsh-tauri-ui": "link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/preset-plugins/dsh-tauri-ui",
                "dshmarket": "github:dsh-market/dshmarket"
            },
            "dsh": {
                "profile": {
                    "bundles": ["dsh-tauri", "dsh-tauri-ui", "dshmarket"]
                }
            }
        });
        let names = HashSet::from(["dsh-tauri", "dsh-tauri-ui"]);

        assert!(remove_internal_plugins_from_manifest(&mut manifest, &names));
        assert_eq!(
            manifest["dependencies"],
            serde_json::json!({ "dshmarket": "github:dsh-market/dshmarket" })
        );
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(["dshmarket"])
        );
        assert!(!remove_internal_plugins_from_manifest(
            &mut manifest,
            &names
        ));
    }

    #[test]
    fn manifest_replacement_preserves_original_when_temp_write_fails() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-manifest-write-failure-{}",
            std::process::id()
        ));
        let path = root.join("package.json");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("sentinel"), "original").unwrap();

        let error = write_profile_manifest(&path, &serde_json::json!({ "private": true }))
            .expect_err("directory destination must reject replacement");

        assert!(error.starts_with("INTERNAL_PLUGIN_MANIFEST_WRITE_FAILED:"));
        assert_eq!(
            std::fs::read_to_string(path.join("sentinel")).unwrap(),
            "original"
        );
        assert!(!root
            .join(format!("package.json.internal.{}.tmp", std::process::id()))
            .exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_plain_directory_is_removed() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-stale-directory-{}",
            std::process::id()
        ));
        let entry = root.join("node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join("partial"), "broken").unwrap();

        remove_stale_plugin_entry(&entry).unwrap();

        assert!(!entry.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn stale_symlink_is_removed_without_touching_target() {
        let root =
            std::env::temp_dir().join(format!("dsh-internal-stale-symlink-{}", std::process::id()));
        let target = root.join("old-app/dsh-tauri-ui");
        let entry = root.join("profile/node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &entry).unwrap();

        remove_stale_plugin_entry(&entry).unwrap();

        assert!(target.join("package.json").is_file());
        assert!(std::fs::symlink_metadata(&entry).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlink_is_removed_idempotently() {
        let root = std::env::temp_dir().join(format!(
            "dsh-internal-dangling-symlink-{}",
            std::process::id()
        ));
        let entry = root.join("profile/node_modules/dsh-tauri-ui");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(root.join("missing-app/dsh-tauri-ui"), &entry).unwrap();

        remove_stale_plugin_entry(&entry).unwrap();
        remove_stale_plugin_entry(&entry).unwrap();

        assert!(std::fs::symlink_metadata(&entry).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn local_link_dep_detects_only_directory_specs() {
        // link:/file: 前缀 → 本地目录链接（含历史遗留 file: 形式）
        assert!(is_local_link_dep("link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"));
        assert!(is_local_link_dep("file:/Applications/.../dsh-tauri-ui"));
        // 无前缀的裸路径、registry 版本、git 引用都不是本地链接，绝不能误卸
        assert!(!is_local_link_dep("dsh-tauri@0.2.0"));
        assert!(!is_local_link_dep("github:dsh-market/dshmarket"));
        assert!(!is_local_link_dep("workspace:*"));
        assert!(!is_local_link_dep(""));
    }

    #[test]
    fn dep_spec_matches_itself() {
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        // 与自身一致
        assert!(dep_matches_spec(expected, expected));
        // 无 link:/file: 前缀（pnpm 某些场景直接落路径）
        assert!(dep_matches_spec(
            "C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
        // 尾部斜杠差异
        assert!(dep_matches_spec(
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri/",
            expected
        ));
        // 反斜杠（Windows 原生形式）
        assert!(dep_matches_spec(
            "link:C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri",
            expected
        ));
        // 历史遗留 file: 形式（协议切换前已安装的值）
        assert!(dep_matches_spec(
            "file:C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }

    #[test]
    fn dep_spec_rejects_wrong_path_or_source() {
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        // 仍指向 npm 版本（用户手动从 npm 安装，非捆绑 link: 源）
        assert!(!dep_matches_spec("dsh-tauri@0.2.0", expected));
        // 指向其它位置（旧版本安装目录等）
        assert!(!dep_matches_spec("link:D:/elsewhere/dsh-tauri", expected));
        // 同名不同宿主盘符
        assert!(!dep_matches_spec(
            "link:D:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }

    #[cfg(windows)]
    #[test]
    fn dep_spec_case_insensitive_on_windows() {
        // Windows 文件系统大小写不敏感，路径比较须忽略大小写
        let expected = "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri";
        assert!(dep_matches_spec(
            "link:c:/apps/DSH/resources/internal-plugins/Dsh-Tauri",
            expected
        ));
        // 实值仍带 Windows 扩展长度前缀（`\\?\`，dunce::simplified 归一化）时，
        // 与归一化掉前缀的期望值仍视为同一路径（幂等，避免不必要的重装）
        assert!(dep_matches_spec(
            "link://?/C:/Apps/dsh/resources/internal-plugins/dsh-tauri",
            expected
        ));
    }
}
