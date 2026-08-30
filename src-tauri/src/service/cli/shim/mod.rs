//! shim 脚本内容生成与落盘：`dsh` / `pnpm` 的 cmd、ps1、sh 包装脚本。
//!
//! 模块划分：
//! - [`templates`]：共享脚本片段常量（node 解析、用户优先逻辑）
//! - [`build`]：各平台 shim 构建函数（纯函数，便于测试）
//! - [`write`]：落盘（生成标记识别、悬空符号链接、用户文件保留）
//!
//! shim 文本必须全英文：cmd/ps1 按系统代码页解析，中文注释会乱码成命令执行。

use std::path::Path;

mod build;
mod templates;
mod write;

pub use write::{is_generated_shim, user_dsh_preserved, write_shims};

/// Windows 下 shim 文件名（cmd 为主入口，ps1 供 PowerShell 原生体验）
pub const SHIM_CMD_NAME: &str = "dsh.cmd";
pub const SHIM_PS1_NAME: &str = "dsh.ps1";
pub const PNPM_SHIM_CMD_NAME: &str = "pnpm.cmd";
pub const PNPM_SHIM_PS1_NAME: &str = "pnpm.ps1";

/// Unix 下 shim 文件名
#[cfg(unix)]
pub const SHIM_SH_NAME: &str = "dsh";
#[cfg(unix)]
pub const PNPM_SHIM_SH_NAME: &str = "pnpm";

// ---------------------------------------------------------------------------
// 路径转义（按目标脚本语言的字符串规则）
// ---------------------------------------------------------------------------

/// 批处理中 `%` 会被展开，需写成 `%%`
#[inline]
pub fn escape_path_cmd(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// 单引号字符串中 `'` 需翻倍
#[inline]
pub fn escape_path_ps1(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// 单引号字符串中 `'` 需写成 `'\''`
#[inline]
pub fn escape_path_sh(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "'\\''")
}

#[cfg(test)]
mod test_util {
    use std::path::PathBuf;

    pub(super) fn sample_app_dir() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(
                r"C:\Users\test\AppData\Roaming\io.github.hairyf.deepseek-harness-desktop",
            )
        } else {
            PathBuf::from("/home/test/.local/share/io.github.hairyf.deepseek-harness-desktop")
        }
    }

    /// 官方 $DSH_HOME（~/.dsh）
    pub(super) fn sample_dsh_home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\test\.dsh")
        } else {
            PathBuf::from("/home/test/.dsh")
        }
    }

    /// 独立的临时目录，避免测试间互相干扰
    pub(super) fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-shim-{tag}-{}-{}",
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
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // escape_path_* 纯函数基线（与 shim 内嵌路径的场景一致）
    // ------------------------------------------------------------------

    #[test]
    fn escape_path_cmd_doubles_percent() {
        assert_eq!(
            escape_path_cmd(Path::new(r"C:\Users\%test%\x")),
            r"C:\Users\%%test%%\x"
        );
        assert_eq!(escape_path_cmd(Path::new("/tmp/a b")), "/tmp/a b");
    }

    #[test]
    fn escape_path_ps1_doubles_single_quotes() {
        assert_eq!(
            escape_path_ps1(Path::new(r"C:\Users\o'brien")),
            r"C:\Users\o''brien"
        );
        assert_eq!(escape_path_ps1(Path::new("/plain/path")), "/plain/path");
    }

    #[test]
    fn escape_path_sh_escapes_single_quotes() {
        assert_eq!(
            escape_path_sh(Path::new("/home/o'brien/.dsh")),
            r"/home/o'\''brien/.dsh"
        );
        assert_eq!(escape_path_sh(Path::new("/plain/.dsh")), "/plain/.dsh");
    }
}
