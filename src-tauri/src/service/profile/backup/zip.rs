//! ZIP 归档与还原的纯文件系统实现（`profile::backup` 的底层）。
//!
//! - 创建：Deflate 压缩；先写临时文件再原子改名。递归归档 Profile 的自定义配置，
//!   但不跟随符号链接，并排除依赖目录与临时标记（`node_modules` / `.pnpm-store` /
//!   `.dsh-rebuild-deps`，见 [`crate::service::profile::is_excluded_from_backup`]）。
//! - 读取：解析 `backup.json`（版本 / Profile ID / 时间 / 原因 / 配置指纹）。
//! - 还原：解压到临时目录后校验 Profile ID、格式、配置 Hash 与安全相对路径
//!   （拒绝绝对路径、`..` 穿越、盘符、符号链接条目），全部通过才允许替换目录。
//!
//! 本模块只接受 `Path` 参数、不做任何 AppHandle 级编排，全部逻辑可被单元测试
//! 直接覆盖（压缩/解压往返、损坏 ZIP、路径穿越、Hash 不匹配等）。

use crate::service::profile::is_excluded_from_backup;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// `backup.json` 的格式版本：解构变化时递增，旧版本备份拒绝还原。
pub(crate) const FORMAT_VERSION: u32 = 1;

/// 凭据条目名（ZIP 根级，与 `backup.json` 同级）：开启 include_credentials 时
/// 写入 `$DSH_HOME/.credentials.yaml` 的内容，还原时由调用方单独写回，不落入
/// profile 目录；仍参与指纹哈希（防篡改）。
pub(crate) const CREDENTIALS_ENTRY: &str = "credentials.yaml";

/// 归档元信息（写入压缩包根部的 `backup.json`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupMeta {
    pub format_version: u32,
    pub profile_id: String,
    pub created_at: i64,
    pub reason: String,
    /// 配置指纹的 SHA-256（还原时重算比对，检测损坏/篡改）
    pub config_hash: String,
}

/// 收集到的归档条目：`None` 内容表示目录（保留空目录结构）
type CollectedEntry = (String, Option<Vec<u8>>);

/// 配置指纹：遍历档案目录（排除依赖目录与临时标记、不跟随符号链接），对每个
/// 文件按「相对路径 + 长度 + 内容」计算 SHA-256。
///
/// 目录不存在或扫描失败返回 `None`；目录存在但无可归档文件时返回空输入集的
/// 哈希（与空备份的还原校验保持一致）。
pub(crate) fn fingerprint(profile_dir: &Path) -> Option<String> {
    fingerprint_with_credentials(profile_dir, None)
}

/// 带凭据内容的配置指纹：`credentials` 为 `Some` 时把 `credentials.yaml` 条目
/// 纳入哈希（备份含凭据时，还原校验必须同样覆盖它，否则无法检测凭据被篡改）。
/// 与 `create_zip` / `extract_and_validate` 的哈希完全同源，保证闭环一致。
pub(crate) fn fingerprint_with_credentials(
    profile_dir: &Path,
    credentials: Option<&[u8]>,
) -> Option<String> {
    let mut entries = collect_entries(profile_dir).ok()?;
    if let Some(bytes) = credentials {
        entries.push((CREDENTIALS_ENTRY.to_string(), Some(bytes.to_vec())));
    }
    Some(hash_entries(&entries))
}

/// 递归收集归档条目（相对路径统一 `/` 分隔，Windows 路径也归一化）
fn collect_entries(root: &Path) -> Result<Vec<CollectedEntry>, String> {
    let mut out = Vec::new();
    walk_collect(root, root, &mut out)?;
    Ok(out)
}

fn walk_collect(root: &Path, dir: &Path, out: &mut Vec<CollectedEntry>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("BACKUP_SCAN_READ: {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("BACKUP_SCAN_ENTRY: {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|e| format!("BACKUP_SCAN_PREFIX: {e}"))?;
        if is_excluded_from_backup(rel) {
            continue;
        }
        // symlink_metadata：符号链接本身不跟随（既不入档也不递归进链接目标）
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("BACKUP_SCAN_META: {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel_name = rel.to_string_lossy().replace('\\', "/");
        if meta.is_dir() {
            out.push((rel_name, None));
            walk_collect(root, &path, out)?;
        } else if meta.is_file() {
            let content = fs::read(&path).map_err(|e| format!("BACKUP_SCAN_READ: {}: {e}", path.display()))?;
            out.push((rel_name, Some(content)));
        }
        // 其余类型（socket/fifo/设备）跳过
    }
    Ok(())
}

/// 对条目集计算指纹哈希（排序后拼接相对路径 + 长度 + 内容）。
///
/// 指纹与 `create_zip` 的归档内容、`extract_and_validate` 的重算完全同源，
/// 保证「备份 → 还原 → 校验」闭环一致。
fn hash_entries(entries: &[CollectedEntry]) -> String {
    let mut sorted: Vec<&CollectedEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, content) in sorted {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        match content {
            Some(bytes) => {
                hasher.update([1u8]);
                hasher.update((bytes.len() as u64).to_le_bytes());
                hasher.update(bytes);
            }
            None => hasher.update([0u8]),
        }
    }
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 创建 Deflate ZIP 备份：`backup.json` + `profile/` 配置内容，可选凭据条目。
///
/// `credentials` 为 `Some` 时把内容写入根级 `credentials.yaml`（与备份时指纹
/// 计算同源）；为 `None` 时压缩包不含凭据。
///
/// 先写同目录临时文件再原子改名，避免半成品 ZIP 被列表/还原流程读到。
pub(crate) fn create_zip(
    profile_dir: &Path,
    dest: &Path,
    meta: &BackupMeta,
    credentials: Option<&[u8]>,
) -> Result<(), String> {
    if !profile_dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: {} is not a directory", profile_dir.display()));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| "BACKUP_PATH_INVALID: destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("BACKUP_MKDIR_FAILED: {e}"))?;
    let tmp = parent.join(format!(
        ".backup-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    let result = (|| -> Result<(), String> {
        let file = File::create(&tmp).map_err(|e| format!("BACKUP_CREATE_FAILED: {e}"))?;
        let mut writer = ZipWriter::new(file);
        let options = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        writer
            .start_file("backup.json", options)
            .map_err(|e| format!("BACKUP_WRITE_META: {e}"))?;
        let meta_json = serde_json::to_vec_pretty(meta)
            .map_err(|e| format!("BACKUP_META_RENDER: {e}"))?;
        writer
            .write_all(&meta_json)
            .map_err(|e| format!("BACKUP_WRITE_META: {e}"))?;

        let mut entries = collect_entries(profile_dir)?;
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (rel, content) in entries {
            let name = format!("profile/{rel}");
            match content {
                Some(bytes) => {
                    writer
                        .start_file(&name, options)
                        .map_err(|e| format!("BACKUP_WRITE_FILE: {name}: {e}"))?;
                    writer
                        .write_all(&bytes)
                        .map_err(|e| format!("BACKUP_WRITE_FILE: {name}: {e}"))?;
                }
                None => {
                    let dir_options = FileOptions::default()
                        .compression_method(CompressionMethod::Deflated)
                        .unix_permissions(0o755);
                    writer
                        .add_directory(&name, dir_options)
                        .map_err(|e| format!("BACKUP_WRITE_DIR: {name}: {e}"))?;
                }
            }
        }
        // 凭据条目（调用方开启包含凭据时）：根级 `credentials.yaml`，与 backup.json
        // 同级、不带 profile/ 前缀；还原时单独写回 `$DSH_HOME/.credentials.yaml`
        if let Some(bytes) = credentials {
            writer
                .start_file(CREDENTIALS_ENTRY, options)
                .map_err(|e| format!("BACKUP_WRITE_CREDENTIALS: {e}"))?;
            writer
                .write_all(bytes)
                .map_err(|e| format!("BACKUP_WRITE_CREDENTIALS: {e}"))?;
        }
        writer.finish().map_err(|e| format!("BACKUP_FINISH_FAILED: {e}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("BACKUP_RENAME_FAILED: {}: {e}", dest.display())
    })
}

/// 读取 ZIP 内的 `backup.json` 并校验格式版本。
pub(crate) fn read_meta(zip_path: &Path) -> Result<BackupMeta, String> {
    let file = File::open(zip_path).map_err(|e| format!("BACKUP_OPEN_FAILED: {}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("BACKUP_INVALID_ZIP: {}: {e}", zip_path.display()))?;
    let mut entry = archive
        .by_name("backup.json")
        .map_err(|e| format!("BACKUP_META_MISSING: {}: {e}", zip_path.display()))?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).map_err(|e| format!("BACKUP_META_READ: {e}"))?;
    let meta: BackupMeta =
        serde_json::from_slice(&buf).map_err(|e| format!("BACKUP_META_INVALID: {e}"))?;
    if meta.format_version != FORMAT_VERSION {
        return Err(format!(
            "BACKUP_FORMAT_UNSUPPORTED: version {} (expected {FORMAT_VERSION})",
            meta.format_version
        ));
    }
    Ok(meta)
}

/// 解压并校验备份到 `dest`（调用方提供的临时目录）：
/// Profile ID 匹配、格式版本、配置 Hash 重算一致、所有条目为安全相对路径。
///
/// 返回备份内携带的凭据内容（`Some`）；备份不含凭据时返回 `None`。凭据条目
/// 只参与哈希校验，不写入 `dest`（写回 `$DSH_HOME/.credentials.yaml` 由调用方负责）。
pub(crate) fn extract_and_validate(
    zip_path: &Path,
    dest: &Path,
    expected_profile_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let meta = read_meta(zip_path)?;
    if meta.profile_id != expected_profile_id {
        return Err(format!(
            "BACKUP_PROFILE_MISMATCH: backup belongs to profile {} but restore target is {expected_profile_id}",
            meta.profile_id
        ));
    }

    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| format!("BACKUP_TMP_CLEAN: {e}"))?;
    }
    fs::create_dir_all(dest).map_err(|e| format!("BACKUP_TMP_MKDIR: {e}"))?;

    let file = File::open(zip_path).map_err(|e| format!("BACKUP_OPEN_FAILED: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("BACKUP_INVALID_ZIP: {e}"))?;
    let mut extracted: Vec<CollectedEntry> = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("BACKUP_ENTRY_READ: {e}"))?;
        let name = entry.name().to_string();
        // 只接受 backup.json（跳过）、credentials.yaml（凭据条目）与 profile/**
        // （解压时剥离 profile/ 前缀）
        let rel = match name.as_str() {
            "backup.json" => continue,
            CREDENTIALS_ENTRY => {
                // 凭据条目：内容单独收集（不落入 profile 目录），还原时由调用方
                // 写回 `$DSH_HOME/.credentials.yaml`；仍参与指纹重算（防篡改）
                let mut buf = Vec::new();
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("BACKUP_EXTRACT_CREDENTIALS_READ: {e}"))?;
                extracted.push((CREDENTIALS_ENTRY.to_string(), Some(buf)));
                continue;
            }
            name if name.starts_with("profile/") => name["profile/".len()..].trim_end_matches('/'),
            _ => {
                return Err(format!("BACKUP_UNEXPECTED_ENTRY: {name}"));
            }
        };
        // 目录条目名可能带尾随 `/`（zip 规范）；去掉后再哈希，与归档时
        // collect_entries 的路径形态保持一致，否则重算指纹必然不匹配
        let rel = rel.trim_end_matches('/');
        // 符号链接条目拒绝（归档时从不写入，防御手工构造的压缩包）
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(format!("BACKUP_SYMLINK_REJECTED: {name}"));
            }
        }
        let rel_path = safe_relative_path(rel)?;
        if entry.is_dir() {
            fs::create_dir_all(dest.join(&rel_path))
                .map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {name}: {e}"))?;
            extracted.push((rel.to_string(), None));
            continue;
        }
        if let Some(parent) = rel_path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(dest.join(parent))
                    .map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {name}: {e}"))?;
            }
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("BACKUP_EXTRACT_READ: {name}: {e}"))?;
        fs::write(dest.join(&rel_path), &buf)
            .map_err(|e| format!("BACKUP_EXTRACT_WRITE: {name}: {e}"))?;
        extracted.push((rel.to_string(), Some(buf)));
    }

    // 配置 Hash 校验：重算解压内容的指纹，与 backup.json 记录比对
    let recomputed = hash_entries(&extracted);
    if recomputed != meta.config_hash {
        return Err(format!(
            "BACKUP_HASH_MISMATCH: config fingerprint mismatch (archive may be corrupted or tampered)"
        ));
    }
    // 取出凭据内容返回给调用方（写回 $DSH_HOME/.credentials.yaml）
    let credentials = extracted
        .iter()
        .find(|(rel, _)| rel == CREDENTIALS_ENTRY)
        .and_then(|(_, content)| content.clone());
    Ok(credentials)
}

/// 把 ZIP 条目名归一化为安全相对路径：拒绝空名、`\` 分隔符、绝对路径、
/// 盘符前缀、`.` / `..` 组件（防路径穿越写出临时目录）。
fn safe_relative_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("BACKUP_EMPTY_ENTRY: empty entry name".to_string());
    }
    if name.contains('\\') {
        return Err(format!("BACKUP_BAD_SEPARATOR: {name}"));
    }
    if name.starts_with('/') {
        return Err(format!("BACKUP_ABSOLUTE_REJECTED: {name}"));
    }
    // 盘符前缀（`C:foo` / `C:/foo`）：zip 规范规定 `/` 分隔，防御手工构造
    if name.len() >= 2
        && name.as_bytes()[0].is_ascii_alphabetic()
        && name.as_bytes()[1] == b':'
    {
        return Err(format!("BACKUP_DRIVE_PREFIX_REJECTED: {name}"));
    }
    let path = Path::new(name);
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => return Err(format!("BACKUP_TRAVERSAL_REJECTED: {name}")),
            Component::ParentDir => return Err(format!("BACKUP_TRAVERSAL_REJECTED: {name}")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("BACKUP_ABSOLUTE_REJECTED: {name}"));
            }
        }
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造临时档案目录：web 模板 + 嵌套自定义配置 + 应排除的依赖目录与标记。
    fn build_profile(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-backup-zip-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(&dir.join(".pnpm-store")).unwrap();
        fs::create_dir_all(&dir.join("custom/nested/deep")).unwrap();
        fs::write(dir.join("package.json"), r#"{"name":"dsh-profile-web"}"#).unwrap();
        fs::write(dir.join("cordis.patch.yml"), "# patch\n").unwrap();
        fs::write(dir.join("pnpm-workspace.yaml"), "packages:\n  - .\n").unwrap();
        fs::write(dir.join("custom/nested/deep/config.json"), r#"{"a":1}"#).unwrap();
        // 依赖与临时标记：不应出现在指纹/压缩包里
        fs::write(dir.join("node_modules/pkg/package.json"), "{}").unwrap();
        fs::write(dir.join(".pnpm-store/state"), "x").unwrap();
        fs::write(dir.join(".dsh-rebuild-deps"), "").unwrap();
        dir
    }

    fn meta_for(profile_id: &str, dir: &Path) -> BackupMeta {
        BackupMeta {
            format_version: FORMAT_VERSION,
            profile_id: profile_id.to_string(),
            created_at: 1_700_000_000_000,
            reason: "manual".to_string(),
            config_hash: fingerprint(dir).unwrap(),
        }
    }

    #[test]
    fn fingerprint_excludes_deps_and_markers() {
        let dir = build_profile("fp");
        // 指纹稳定（重复计算一致）
        assert_eq!(fingerprint(&dir), fingerprint(&dir));
        // 修改依赖目录内容不影响指纹
        fs::write(dir.join("node_modules/pkg/package.json"), "{\"changed\":true}").unwrap();
        let before = fingerprint(&dir).unwrap();
        fs::write(dir.join("node_modules/pkg/package.json"), "{}").unwrap();
        assert_eq!(fingerprint(&dir).unwrap(), before);
        // 修改自定义配置改变指纹
        fs::write(dir.join("custom/nested/deep/config.json"), r#"{"a":2}"#).unwrap();
        assert_ne!(fingerprint(&dir).unwrap(), before);
        // 空目录的指纹存在（Some），不存在的目录为 None
        let empty = std::env::temp_dir().join(format!("dsh-backup-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&empty);
        fs::create_dir_all(&empty).unwrap();
        assert!(fingerprint(&empty).is_some());
        assert!(fingerprint(&std::env::temp_dir().join("dsh-backup-does-not-exist-xyz")).is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn zip_roundtrip_preserves_config_and_meta() {
        let dir = build_profile("roundtrip");
        let dest = dir.parent().unwrap().join("roundtrip.zip");
        create_zip(&dir, &dest, &meta_for("web", &dir), None).unwrap();

        let meta = read_meta(&dest).unwrap();
        assert_eq!(meta.profile_id, "web");
        assert_eq!(meta.reason, "manual");

        let out = dir.parent().unwrap().join("roundtrip-out");
        let credentials = extract_and_validate(&dest, &out, "web").unwrap();
        assert!(credentials.is_none(), "不带凭据的备份还原不应返回凭据内容");
        // 嵌套自定义配置完整保留
        assert_eq!(
            fs::read_to_string(out.join("custom/nested/deep/config.json")).unwrap(),
            r#"{"a":1}"#
        );
        assert_eq!(fs::read_to_string(out.join("package.json")).unwrap(), r#"{"name":"dsh-profile-web"}"#);
        // 依赖目录与临时标记不入档
        assert!(!out.join("node_modules").exists());
        assert!(!out.join(".pnpm-store").exists());
        assert!(!out.join(".dsh-rebuild-deps").exists());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn restore_rejects_corrupted_zip() {
        let dir = build_profile("corrupt");
        let dest = dir.parent().unwrap().join("corrupt.zip");
        create_zip(&dir, &dest, &meta_for("web", &dir), None).unwrap();
        // 截断文件模拟损坏
        let bytes = fs::read(&dest).unwrap();
        fs::write(&dest, &bytes[..bytes.len() / 2]).unwrap();
        let out = dir.parent().unwrap().join("corrupt-out");
        let err = extract_and_validate(&dest, &out, "web").unwrap_err();
        assert!(err.starts_with("BACKUP_INVALID_ZIP:") || err.starts_with("BACKUP_META_"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn restore_rejects_wrong_profile_id() {
        let dir = build_profile("wrongid");
        let dest = dir.parent().unwrap().join("wrongid.zip");
        create_zip(&dir, &dest, &meta_for("web", &dir), None).unwrap();
        let out = dir.parent().unwrap().join("wrongid-out");
        let err = extract_and_validate(&dest, &out, "beta").unwrap_err();
        assert!(err.starts_with("BACKUP_PROFILE_MISMATCH"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn restore_rejects_hash_mismatch() {
        let dir = build_profile("hash");
        let dest = dir.parent().unwrap().join("hash.zip");
        let mut meta = meta_for("web", &dir);
        // 篡改记录的哈希 → 重算比对失败
        meta.config_hash = "0".repeat(64);
        create_zip(&dir, &dest, &meta, None).unwrap();
        let out = dir.parent().unwrap().join("hash-out");
        let err = extract_and_validate(&dest, &out, "web").unwrap_err();
        assert!(err.starts_with("BACKUP_HASH_MISMATCH"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn restore_rejects_unsupported_format_version() {
        let dir = build_profile("version");
        let dest = dir.parent().unwrap().join("version.zip");
        let mut meta = meta_for("web", &dir);
        meta.format_version = 99;
        create_zip(&dir, &dest, &meta, None).unwrap();
        let out = dir.parent().unwrap().join("version-out");
        let err = extract_and_validate(&dest, &out, "web").unwrap_err();
        assert!(err.starts_with("BACKUP_FORMAT_UNSUPPORTED"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn zip_with_credentials_roundtrips_and_covers_hash() {
        let dir = build_profile("cred");
        let dest = dir.parent().unwrap().join("cred.zip");
        let secrets = b"token: s3cret\n";
        let meta = BackupMeta {
            format_version: FORMAT_VERSION,
            profile_id: "web".to_string(),
            created_at: 1_700_000_000_000,
            reason: "manual".to_string(),
            // 凭据内容必须参与指纹，否则还原校验覆盖不到凭据
            config_hash: fingerprint_with_credentials(&dir, Some(secrets)).unwrap(),
        };
        create_zip(&dir, &dest, &meta, Some(secrets)).unwrap();

        // 还原：凭据内容单独返回（供写回 $DSH_HOME/.credentials.yaml），
        // 不落入 profile 目录
        let out = dir.parent().unwrap().join("cred-out");
        let restored = extract_and_validate(&dest, &out, "web").unwrap();
        assert_eq!(restored.as_deref(), Some(secrets.as_slice()));
        assert!(!out.join(CREDENTIALS_ENTRY).exists(), "凭据不应解压进 profile 目录");
        assert_eq!(
            fs::read_to_string(out.join("package.json")).unwrap(),
            r#"{"name":"dsh-profile-web"}"#
        );

        // 凭据被篡改（归档内容与指纹不一致）→ 哈希校验失败
        let tampered_meta = BackupMeta {
            config_hash: fingerprint_with_credentials(&dir, Some(b"tampered")).unwrap(),
            ..meta.clone()
        };
        let dest2 = dir.parent().unwrap().join("cred-tampered.zip");
        create_zip(&dir, &dest2, &tampered_meta, Some(secrets)).unwrap();
        let err = extract_and_validate(&dest2, &out, "web").unwrap_err();
        assert!(err.starts_with("BACKUP_HASH_MISMATCH"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
        let _ = fs::remove_file(&dest2);
        let _ = fs::remove_dir_all(&out);
    }

    /// 手工构造含恶意条目的 ZIP（路径穿越 / 绝对路径 / 盘符 / 反斜杠），
    /// 解压必须全部拒绝。压缩包先写入合法的 backup.json，保证校验走到条目层。
    #[test]
    fn restore_rejects_path_traversal_entries() {
        let cases = [
            ("profile/../evil.txt", "BACKUP_TRAVERSAL_REJECTED"),
            ("profile/a/../../evil.txt", "BACKUP_TRAVERSAL_REJECTED"),
            ("profile/./x", "BACKUP_TRAVERSAL_REJECTED"),
            ("profile//etc/passwd", "BACKUP_ABSOLUTE_REJECTED"),
            ("profile/C:/evil.txt", "BACKUP_DRIVE_PREFIX_REJECTED"),
            ("profile/..\\evil.txt", "BACKUP_BAD_SEPARATOR"),
        ];
        let root = std::env::temp_dir().join(format!("dsh-backup-malicious-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for (index, (name, expected_prefix)) in cases.iter().enumerate() {
            let zip_path = root.join(format!("malicious-{index}.zip"));
            let file = File::create(&zip_path).unwrap();
            let mut writer = ZipWriter::new(file);
            let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
            // 合法元信息：profileId 匹配、哈希任意（条目校验先于哈希校验）
            let meta = serde_json::to_vec(&BackupMeta {
                format_version: FORMAT_VERSION,
                profile_id: "web".into(),
                created_at: 1_700_000_000_000,
                reason: "manual".into(),
                config_hash: "0".repeat(64),
            })
            .unwrap();
            writer.start_file("backup.json", options).unwrap();
            writer.write_all(&meta).unwrap();
            writer.start_file(*name, options).unwrap();
            writer.write_all(b"evil").unwrap();
            writer.finish().unwrap();
            let out = root.join(format!("out-{index}"));
            let err = extract_and_validate(&zip_path, &out, "web").unwrap_err();
            assert!(
                err.starts_with(expected_prefix),
                "case {name:?}: expected {expected_prefix}, got {err}"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn safe_relative_path_rejects_every_escape_shape() {
        for bad in [
            "", ".", "..", "./x", "../x", "a/../b", "/abs", "//abs", "C:x", "C:/x", "c:\\x",
            "a\\b", "..\\x",
        ] {
            assert!(safe_relative_path(bad).is_err(), "should reject {bad:?}");
        }
        for good in ["package.json", "custom/nested/config.json", "a", "a/b/c"] {
            assert!(safe_relative_path(good).is_ok(), "should accept {good:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn archive_skips_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = build_profile("symlink");
        // 指向档案外的符号链接：不跟随、不入档
        symlink("/etc/hostname", dir.join("escape-link")).unwrap();
        assert!(!fingerprint(&dir).unwrap().is_empty());
        let before = fingerprint(&dir).unwrap();
        fs::remove_file(dir.join("escape-link")).unwrap();
        assert_eq!(fingerprint(&dir).unwrap(), before);
        let _ = fs::remove_dir_all(&dir);
    }
}
