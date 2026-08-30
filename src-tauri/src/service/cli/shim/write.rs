//! shim 落盘：生成标记识别、悬空符号链接处理、用户文件保留与写入编排。

use crate::config;
use std::fs;
use std::path::Path;
use tauri::AppHandle;

#[cfg(not(windows))]
#[allow(unused_imports)] // debug 构建 dsh shim 不写入；测试仍引用
use super::build::build_sh_shim;
#[allow(unused_imports)] // 构建函数在 debug 构建/异平台下由 cfg 裁剪，测试仍引用
use super::build::{
    build_cmd_shim, build_pnpm_cmd_shim, build_pnpm_ps1_shim, build_pnpm_sh_shim, build_ps1_shim,
};
#[cfg(all(windows, not(debug_assertions)))]
use super::SHIM_PS1_NAME;
#[cfg(windows)]
use super::{PNPM_SHIM_CMD_NAME, PNPM_SHIM_PS1_NAME, SHIM_CMD_NAME};
#[cfg(not(windows))]
use super::{PNPM_SHIM_SH_NAME, SHIM_SH_NAME};

/// 生成的 shim 自带的可识别标记（首行注释）。用于区分"本应用生成的 shim"
/// 与"用户自行放置的同名文件"。读文件只读该标记行，避免误删用户自有文件。
const GENERATED_MARKER: &str = "DeepSeek Harness Desktop - ";

/// 目标路径已存在且不是本应用生成的 shim（即用户手动放置的 `dsh`/`pnpm`）。
///
/// 此时绝不覆盖，保留用户文件，避免"安装后清空了之前手动安装的工具"。
fn is_foreign_file(path: &Path) -> bool {
    !is_generated_shim(path)
}

/// 路径是否为悬空符号链接（链接本身存在，但指向的目标不存在）。
///
/// 官方 dsh 安装器会在 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh` 留下
/// 符号链接；当 `current` 指向的目录被移动/删除后链接即悬空。此时
/// `Path::exists()` 跟随链接返回 `false`，但直接 `fs::write` 会沿链接打开目标
/// 并在其父目录缺失时报 `No such file or directory (os error 2)`——必须先把
/// 已失效的链接本身移除，才能按"文件不存在"正常写入。
fn is_dangling_symlink(path: &Path) -> bool {
    match path.symlink_metadata() {
        Ok(meta) => meta.file_type().is_symlink() && !path.exists(),
        Err(_) => false,
    }
}

/// 判断路径是否为本应用生成的 shim（生成标记出现在文件头部固定位置）。
///
/// 用于在本地 dsh 探测中区分"本应用 shim"与"用户自行放置的同名文件"：
/// 前者应被排除（它转发到捆绑 dsh，不构成用户本地核心），后者应被识别。
///
/// 标记只在前两行匹配：所有生成的 shim 都在头部第一行（cmd 是 @echo off
/// 后的第二行）写 #/rem DeepSeek Harness Desktop - ...；用户文件即使正文
/// 提到同样的短语（如 README 引用）也不应被误判为本应用 shim。
pub fn is_generated_shim(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .take(2)
            .any(|line| line.contains(GENERATED_MARKER)),
        Err(_) => false,
    }
}

/// 写入单个 shim 文件，处理目标已存在时的三种情形：
///
/// 1. 悬空符号链接（用户/官方安装器残留、目标已失效）→ 移除链接后正常写入；
/// 2. 已存在且非本应用生成（用户手动放置的 `dsh`/`pnpm`）→ 跳过，保留用户文件；
/// 3. 其余（不存在，或本应用生成的 shim）→ 直接写入/覆盖。
fn write_shim_file(target: &Path, content: &str) -> Result<(), String> {
    if is_dangling_symlink(target) {
        log::warn!(
            "Removing dangling symlink {:?} before writing shim (its target is gone)",
            target
        );
        fs::remove_file(target).map_err(|e| {
            format!(
                "SHIM_REMOVE_LINK_FAILED: remove dangling symlink {} failed: {e}",
                target.display()
            )
        })?;
    }
    if target.exists() && is_foreign_file(target) {
        log::warn!(
            "Skipping shim write to {:?}: an existing user file is preserved",
            target
        );
        return Ok(());
    }
    fs::write(target, content)
        .map_err(|e| format!("SHIM_WRITE_FAILED: write {} failed: {e}", target.display()))
}

/// 主 `dsh` shim 路径下是否保留了用户自行安装的同名文件（用于状态展示）。
pub fn user_dsh_preserved(bin_dir: &Path) -> bool {
    let path = {
        #[cfg(windows)]
        {
            bin_dir.join(SHIM_CMD_NAME)
        }
        #[cfg(not(windows))]
        {
            bin_dir.join(SHIM_SH_NAME)
        }
    };
    path.is_file() && is_foreign_file(&path)
}

/// 将 shim 文件写入 bin 目录；目标已存在但非本应用生成的同名文件时跳过（保留）。
/// 目标为悬空符号链接时先移除链接再写入（链接目标已失效，保留只会让写入
/// 报 ENOENT）。
///
/// 覆盖式仅针对本应用生成的 shim（自愈时内容与当前安装一致）；用户手动放置的
/// 同名 `dsh`/`pnpm` 一律保留不动，避免覆盖用户自己的安装与配置。
pub fn write_shims(app_handle: &AppHandle, bin_dir: &Path) -> Result<(), String> {
    let app_dir = config::get_base_dir(app_handle);
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("SHIM_MKDIR_FAILED: create bin dir failed: {e}"))?;

    // 写入单个 shim：若目标已存在且非本应用生成，则跳过不覆盖（保留用户文件）。
    macro_rules! write_if_ours {
        ($path:expr, $content:expr) => {{
            let target = bin_dir.join($path);
            write_shim_file(&target, &$content)?;
            target
        }};
    }

    // dsh shim 会在内容里烘焙 $DSH_HOME（生产为 ~/.dsh、开发为 ~/.dsh.dev）。
    // 开发构建禁止改写用户共享的 dsh shim——改写会让终端 `dsh` 指向开发数据
    // 目录，并覆盖生产的命令行集成；生产版生成的 dsh shim 原样保留。
    #[cfg(not(debug_assertions))]
    {
        let dsh_home = config::get_dsh_data_path(app_handle);
        #[cfg(windows)]
        {
            write_if_ours!(SHIM_CMD_NAME, build_cmd_shim(&app_dir, &dsh_home));
            write_if_ours!(SHIM_PS1_NAME, build_ps1_shim(&app_dir, &dsh_home));
        }
        #[cfg(not(windows))]
        {
            write_if_ours!(SHIM_SH_NAME, build_sh_shim(&app_dir, &dsh_home));
        }
    }
    #[cfg(debug_assertions)]
    log::debug!("debug build: skip dsh shim write (shared user state kept for release)");

    // pnpm shim 不烘焙 $DSH_HOME（仅绑定 bundle 目录与“用户 pnpm 优先”逻辑），
    // 内容与生产完全一致，开发构建也可写入——dsh plugin 子进程经 PATH 解析
    // pnpm 依赖它，写它不污染任何共享数据。
    #[cfg(windows)]
    {
        write_if_ours!(PNPM_SHIM_CMD_NAME, build_pnpm_cmd_shim(&app_dir));
        write_if_ours!(PNPM_SHIM_PS1_NAME, build_pnpm_ps1_shim(&app_dir));
    }
    #[cfg(not(windows))]
    {
        write_if_ours!(PNPM_SHIM_SH_NAME, build_pnpm_sh_shim(&app_dir));
        // 仅对本应用生成/覆盖过的 shim 设置可执行位；保留的用户文件不动
        let chmod_names: &[&str] = if cfg!(debug_assertions) {
            &[PNPM_SHIM_SH_NAME]
        } else {
            &[SHIM_SH_NAME, PNPM_SHIM_SH_NAME]
        };
        for name in chmod_names {
            let path = bin_dir.join(name);
            if path.is_file() && !is_foreign_file(&path) {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("SHIM_CHMOD_FAILED: chmod shim failed: {e}"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::test_util::{sample_app_dir, sample_dsh_home};
    use super::*;

    #[test]
    fn foreign_file_detection() {
        let dir = std::env::temp_dir().join(format!("dsh-shim-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 用户手动放置的 dsh 脚本 -> 视为 foreign，不应被覆盖
        let user_dsh = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        std::fs::write(&user_dsh, "#!/bin/sh\necho my real dsh\n").unwrap();
        assert!(
            is_foreign_file(&user_dsh),
            "user file must be treated as foreign"
        );

        // 本应用生成的 shim -> 不是 foreign，可覆盖
        #[cfg(not(windows))]
        let generated = build_sh_shim(&sample_app_dir(), &sample_dsh_home());
        #[cfg(windows)]
        let generated = build_cmd_shim(&sample_app_dir(), &sample_dsh_home());
        std::fs::write(&user_dsh, generated).unwrap();
        assert!(
            !is_foreign_file(&user_dsh),
            "generated shim must not be foreign"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------
    // write_shim_file 目标文件处理（悬空符号链接 / 用户文件保留 / 生成文件覆盖）
    // ------------------------------------------------------------------

    /// 独立的临时目录，避免测试间互相干扰
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-shim-write-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 悬空符号链接（官方 dsh 安装器残留 `~/.local/bin/dsh -> ~/.dsh/source/current/bin/dsh`
    /// 且目标已消失）时：先移除失效链接，再正常写入生成 shim——修复原报错
    /// `write ... failed: No such file or directory (os error 2)`
    #[test]
    #[cfg(unix)]
    fn write_shim_file_removes_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("dangling");
        let target = dir.join("dsh");
        symlink(dir.join("missing/source/current/bin/dsh"), &target).unwrap();
        assert!(is_dangling_symlink(&target));

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\ngenerated shim\n"
        );
        assert!(
            !std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "dangling symlink must be replaced by a regular file"
        );
        assert!(!is_dangling_symlink(&target));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 指向真实用户 dsh 的符号链接（目标仍存在）→ 视为用户文件，保留不动
    #[test]
    #[cfg(unix)]
    fn write_shim_file_preserves_valid_user_symlink() {
        use std::os::unix::fs::symlink;

        let dir = temp_dir("userlink");
        let real = dir.join("real-dsh");
        std::fs::write(&real, "#!/bin/sh\necho my real dsh\n").unwrap();
        let target = dir.join("dsh");
        symlink(&real, &target).unwrap();

        write_shim_file(&target, "#!/bin/sh\ngenerated shim\n").unwrap();

        assert!(
            std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "valid user symlink must be preserved"
        );
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "#!/bin/sh\necho my real dsh\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户文件只在正文提到生成短语（非头部）→ 仍视为 foreign，不得覆盖
    #[test]
    fn generated_phrase_outside_header_is_not_generated_shim() {
        let dir =
            std::env::temp_dir().join(format!("dsh-shim-header-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        // 前两行不是标记（用户脚本），正文（第三行）却提到"DeepSeek Harness Desktop - "
        std::fs::write(
            &target,
            "@echo off\necho user shim\necho see DeepSeek Harness Desktop - readme note here\n",
        )
        .unwrap();
        assert!(
            is_foreign_file(&target),
            "phrase outside the header must not mark a user file as generated"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本应用生成的 shim → 覆盖自愈内容
    #[test]
    fn write_shim_file_overwrites_generated_shim() {
        let dir = temp_dir("overwrite");
        let target = dir.join("dsh");
        std::fs::write(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - old shim\n",
        )
        .unwrap();

        write_shim_file(
            &target,
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n",
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "#!/bin/sh\n# DeepSeek Harness Desktop - new shim\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
