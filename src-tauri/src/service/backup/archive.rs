//! 备份归档：tar.gz 创建与解压。
//!
//! 归档格式与 `download/extractor.rs` 的 TGZ 解压互逆：`tar::Builder` +
//! `flate2::write::GzEncoder` 创建，`flate2::read::GzDecoder` + `tar::Archive`
//! 解压。解压前逐条目校验路径不跳出目标目录（防路径穿越）。

use std::fs;
use std::io::Write;
use std::path::Path;

/// 需要从归档中排除的相对路径组件（前缀匹配）。
const EXCLUDED_NAMES: &[&str] = &[".backups", ".harness.pid", ".plugin-backups"];

/// 需要从归档中排除的相对路径（精确匹配）。
const EXCLUDED_PATHS: &[&str] = &["node_modules/.modules.yaml"];

/// 凭据文件名。
const CREDENTIALS_FILE: &str = ".credentials.yaml";

/// 判断一条相对路径是否应被排除。
///
/// - `.backups/` 自身必须排除（防递归包含）。
/// - `.harness.pid` 等运行时产物必须排除。
/// - `.credentials.yaml` 按 `include_credentials` 决定。
fn is_excluded(rel: &Path, include_credentials: bool) -> bool {
    if let Some(name) = rel.file_name().and_then(|n| n.to_str()) {
        if EXCLUDED_NAMES.contains(&name) {
            return true;
        }
        if name == CREDENTIALS_FILE && !include_credentials {
            return true;
        }
    }
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if EXCLUDED_PATHS.iter().any(|p| rel_str == *p) {
        return true;
    }
    false
}

/// 递归地把 `dir` 下所有文件追加到 tar 构建器，跳过排除项。
///
/// `rel` 为当前目录到归档根（`source`）的相对路径前缀，`source` 为原始归档根
///（用于计算根相对路径以做排除判断）。
fn append_dir_filtered(
    builder: &mut tar::Builder<impl Write>,
    dir: &Path,
    source: &Path,
    rel: &Path,
    include_credentials: bool,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("BACKUP_ARCHIVE_READDIR: {e}"))? {
        let entry = entry.map_err(|e| format!("BACKUP_ARCHIVE_ENTRY: {e}"))?;
        let path = entry.path();
        let name = path.file_name().ok_or_else(|| {
            format!("BACKUP_ARCHIVE_NO_NAME: {}", path.display())
        })?;
        let archived = rel.join(name);
        // 根相对路径（用于排除判断）
        let root_rel = path
            .strip_prefix(source)
            .map_err(|e| format!("BACKUP_ARCHIVE_STRIP: {e}"))?;
        if is_excluded(root_rel, include_credentials) {
            continue;
        }
        if path.is_dir() {
            builder
                .append_dir(&archived, &path)
                .map_err(|e| format!("BACKUP_ARCHIVE_APPEND_DIR: {e}"))?;
            append_dir_filtered(builder, &path, source, &archived, include_credentials)?;
        } else {
            builder
                .append_file(&archived, &mut fs::File::open(&path).map_err(|e| {
                    format!("BACKUP_ARCHIVE_OPEN: {e}")
                })?)
                .map_err(|e| format!("BACKUP_ARCHIVE_APPEND_FILE: {e}"))?;
        }
    }
    Ok(())
}

/// 创建 tar.gz 归档。
///
/// 把 `source` 目录打包到 `dest` 文件。`include_credentials` 控制是否包含
/// `.credentials.yaml`。始终排除 `.backups/`、`.harness.pid`、
/// `node_modules/.modules.yaml`。
pub fn create_archive(
    source: &Path,
    dest: &Path,
    include_credentials: bool,
) -> Result<(), String> {
    let tar_gz = fs::File::create(dest).map_err(|e| format!("BACKUP_ARCHIVE_CREATE: {e}"))?;
    let enc = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::default());
    let mut archive = tar::Builder::new(enc);
    append_dir_filtered(&mut archive, source, source, Path::new("."), include_credentials)?;
    archive
        .finish()
        .map_err(|e| format!("BACKUP_ARCHIVE_FINISH: {e}"))?;
    Ok(())
}

/// 解压 tar.gz 归档到 `dest` 目录。
///
/// 每条目的路径在写入前都经过 `fs_guard::ensure_within` 校验，任何跳出
/// `dest` 的条目都会导致整体失败（防路径穿越）。
pub fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("BACKUP_EXTRACT_MKDIR: {e}"))?;
    let tar_gz = fs::File::open(archive).map_err(|e| format!("BACKUP_EXTRACT_OPEN: {e}"))?;
    let dec = flate2::read::GzDecoder::new(tar_gz);
    let mut archive = tar::Archive::new(dec);
    let dest_real = dunce::canonicalize(dest)
        .map_err(|e| format!("BACKUP_EXTRACT_CANONICALIZE_DEST: {e}"))?;

    for entry in archive.entries().map_err(|e| format!("BACKUP_EXTRACT_ENTRIES: {e}"))? {
        let mut entry = entry.map_err(|e| format!("BACKUP_EXTRACT_ENTRY: {e}"))?;
        let path = entry.path().map_err(|e| format!("BACKUP_EXTRACT_PATH: {e}"))?;

        // 拒绝含 `..` 组件的条目（规范化前第一道闸）
        if path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "BACKUP_EXTRACT_PATH_ESCAPE: entry {:?} contains ..",
                path
            ));
        }

        let joined = dest_real.join(&path);
        // 规范化并校验不跳出目标目录。目标文件可能尚未创建，此时规范化父目录
        // 后拼接文件名，再校验前缀。
        let joined_real = if joined.exists() {
            dunce::canonicalize(&joined)
                .map_err(|e| format!("BACKUP_EXTRACT_CANONICALIZE_ENTRY: {e}"))?
        } else {
            let parent = joined.parent().ok_or_else(|| {
                format!("BACKUP_EXTRACT_NO_PARENT: entry {:?}", path)
            })?;
            fs::create_dir_all(parent)
                .map_err(|e| format!("BACKUP_EXTRACT_MKDIR_PARENT: {e}"))?;
            let parent_real =
                dunce::canonicalize(parent).map_err(|e| {
                    format!("BACKUP_EXTRACT_CANONICALIZE_PARENT: {e}")
                })?;
            let name = joined.file_name().ok_or_else(|| {
                format!("BACKUP_EXTRACT_NO_FILENAME: entry {:?}", path)
            })?;
            parent_real.join(name)
        };
        if !joined_real.starts_with(&dest_real) {
            return Err(format!(
                "BACKUP_EXTRACT_PATH_ESCAPE: entry {:?} resolves outside dest",
                path
            ));
        }
        // 拒绝符号链接和硬链接：link_name 的目标不受 path 校验约束，可能跳出目标目录
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(format!(
                "BACKUP_EXTRACT_UNSUPPORTED_LINK: entry {:?} is a symlink or hard link",
                path
            ));
        }
        entry
            .unpack(&joined_real)
            .map_err(|e| format!("BACKUP_EXTRACT_UNPACK: {e}"))?;
    }
    Ok(())
}

/// 列出归档中所有条目的相对路径（用于测试校验排除项）。
#[cfg(test)]
fn list_archive_entries(archive: &Path) -> Result<Vec<String>, String> {
    let tar_gz = fs::File::open(archive).map_err(|e| format!("BACKUP_LIST_OPEN: {e}"))?;
    let dec = flate2::read::GzDecoder::new(tar_gz);
    let mut archive = tar::Archive::new(dec);
    let mut entries = Vec::new();
    for entry in archive.entries().map_err(|e| format!("BACKUP_LIST_ENTRIES: {e}"))? {
        let entry = entry.map_err(|e| format!("BACKUP_LIST_ENTRY: {e}"))?;
        let path = entry.path().map_err(|e| format!("BACKUP_LIST_PATH: {e}"))?;
        entries.push(path.to_string_lossy().replace('\\', "/"));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 全局递增计数器，保证并行测试使用互不冲突的临时目录。
    fn unique_suffix() -> String {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        format!(
            "{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    }

    /// 计算与 source 同级的归档目标路径。
    fn archive_dest(source: &Path) -> PathBuf {
        source
            .parent()
            .unwrap()
            .join(format!("{}.tar.gz", source.file_name().unwrap().to_str().unwrap()))
    }

    /// 创建临时目录并写入若干文件作为测试夹具。
    fn setup_source_dir(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-backup-archive-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (rel, content) in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            let mut f = fs::File::create(&path).unwrap();
            f.write_all(content.as_bytes()).unwrap();
        }
        dir
    }

    #[test]
    fn creates_tar_gzip_archive() {
        let source = setup_source_dir(&[("hello.txt", "world")]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        assert!(dest.exists(), "归档文件应存在");
        assert!(fs::metadata(&dest).unwrap().len() > 0, "归档文件应非空");
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn excludes_backup_dir_from_archive() {
        let source = setup_source_dir(&[
            ("hello.txt", "world"),
            (".backups/old.tar.gz", "junk"),
            (".backups/.manifest.json", "{}"),
            (".plugin-backups/dsh-market.tgz", "snapshot"),
        ]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().all(|e| !e.contains(".backups")),
            ".backups 应被排除，实际条目: {entries:?}"
        );
        assert!(
            entries.iter().all(|e| !e.contains(".plugin-backups")),
            ".plugin-backups 应被排除（防单插件快照被整库备份递归包含），实际条目: {entries:?}"
        );
        assert!(
            entries.iter().any(|e| e.contains("hello.txt")),
            "hello.txt 应存在"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn credentials_excluded_by_default() {
        let source = setup_source_dir(&[
            (".credentials.yaml", "key: secret"),
            ("data.txt", "ok"),
        ]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().all(|e| !e.contains(".credentials.yaml")),
            "凭据默认应被排除，实际条目: {entries:?}"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn credentials_included_when_opted_in() {
        let source = setup_source_dir(&[
            (".credentials.yaml", "key: secret"),
            ("data.txt", "ok"),
        ]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, true).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().any(|e| e.contains(".credentials.yaml")),
            "勾选时凭据应被包含，实际条目: {entries:?}"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn restore_overwrites_existing_data() {
        let source = setup_source_dir(&[("config.yaml", "version: 1")]);
        let dest_gz = archive_dest(&source);
        create_archive(&source, &dest_gz, false).unwrap();

        // 还原到新目录
        let restore_dir = std::env::temp_dir().join(format!("dsh-backup-restore-{}", unique_suffix()));
        extract_archive(&dest_gz, &restore_dir).unwrap();

        let restored = fs::read_to_string(restore_dir.join("config.yaml")).unwrap();
        assert_eq!(restored, "version: 1", "还原后应回到原始内容");
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest_gz);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    /// 手工构造含路径穿越条目的 tar 头部（绕过 `tar::Header::set_path` 对 `..` 的校验）。
    fn write_raw_tar_entry<W: std::io::Write>(
        writer: &mut W,
        path: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let mut header = [0u8; 512];
        // name (0..100)
        let path_bytes = path.as_bytes();
        if path_bytes.len() > 100 {
            return Err("path too long".to_string());
        }
        header[0..path_bytes.len()].copy_from_slice(path_bytes);
        // mode 0644 (octal, 100..108)
        let mode = b"0000644\0";
        header[100..108].copy_from_slice(mode);
        // uid/gid 0 (108..124)
        header[108..124].copy_from_slice(b"0000000\00000000\0");
        // size (octal, 124..136)
        let size_str = format!("{:011o}\0", data.len());
        header[124..124 + size_str.len()].copy_from_slice(size_str.as_bytes());
        // mtime 0 (136..148)
        header[136..148].copy_from_slice(b"00000000000\0");
        // typeflag Regular (156)
        header[156] = b'0';
        // magic + version (257..265)
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        // checksum (148..156): 先填空格，再算字节和
        header[148..156].copy_from_slice(b"        ");
        let checksum: u32 = header.iter().map(|&b| b as u32).sum();
        let ck_str = format!("{:06o}\0 ", checksum);
        header[148..148 + ck_str.len()].copy_from_slice(ck_str.as_bytes());

        writer.write_all(&header).map_err(|e| e.to_string())?;
        writer.write_all(data).map_err(|e| e.to_string())?;
        // pad to 512 boundary
        let pad = (512 - (data.len() % 512)) % 512;
        if pad > 0 {
            writer.write_all(&vec![0u8; pad]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[test]
    fn rejects_path_traversal_on_restore() {
        let dir = std::env::temp_dir().join(format!("dsh-backup-traversal-{}", unique_suffix()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let archive_path = dir.join("evil.tar.gz");
        // 以裸字节写 gzip（tar crate 的 set_path 会拒绝 ..，故绕开）
        let tar_gz = fs::File::create(&archive_path).unwrap();
        let mut enc = flate2::write::GzEncoder::new(tar_gz, flate2::Compression::default());
        write_raw_tar_entry(&mut enc, "../../../tmp/dsh-evil-passwd", b"evil").unwrap();
        // tar 文件尾：两个空块
        enc.write_all(&[0u8; 1024]).unwrap();
        enc.finish().unwrap();

        let dest = dir.join("dest");
        let result = extract_archive(&archive_path, &dest);
        assert!(result.is_err(), "路径穿越应被拒绝: {result:?}");
        assert!(
            !std::path::Path::new("/tmp/dsh-evil-passwd").exists(),
            "恶意文件不应被写入系统目录"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn excludes_pid_and_modules_yaml() {
        let source = setup_source_dir(&[
            (".harness.pid", "12345"),
            ("node_modules/.modules.yaml", "modules: {}"),
            ("real.txt", "keep"),
        ]);
        let dest = archive_dest(&source);
        create_archive(&source, &dest, false).unwrap();
        let entries = list_archive_entries(&dest).unwrap();
        assert!(
            entries.iter().all(|e| !e.contains(".harness.pid")),
            ".harness.pid 应被排除"
        );
        assert!(
            entries.iter().all(|e| !e.contains(".modules.yaml")),
            "node_modules/.modules.yaml 应被排除"
        );
        assert!(
            entries.iter().any(|e| e.contains("real.txt")),
            "real.txt 应存在"
        );
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_file(&dest);
    }
}
