use std::path::{Path, PathBuf};

/// Linux inotify 文件监视上限的推荐最小值。
///
/// harness 服务（dsh web）用 chokidar 递归监视 `$DSH_HOME/profiles/*`，node 的
/// 每个被监视目录都要消耗一个 inotify watch。系统默认值在新版 Ubuntu 上往往过小
/// （如 65536），一旦监视到 `node_modules` 等庞大树就抛
/// `ENOSPC: System limit for number of file watchers reached` 并使服务启动即崩溃
/// （issue #116）。低于该推荐值时在启动日志给出明确提示，引导用户调高参数。
#[cfg(unix)]
pub const MIN_INOTIFY_MAX_USER_WATCHES: u64 = 524_288;

/// 读取 Linux `fs.inotify.max_user_watches` 系统参数。
///
/// 进程无法自我调高该参数（需要 root / sysctl），但启动前探测并告警能让用户第一
/// 时间知道「服务崩溃与系统监视上限有关」，而非看到一串 node 堆栈不知所云。
/// 仅 Unix 存在该 procfs 节点；Windows / macOS 返回 None。纯函数，便于单测。
#[cfg(unix)]
pub fn linux_inotify_max_user_watches() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches").ok()?;
    content.trim().parse::<u64>().ok()
}

/// 生成不冲突的下载路径：目标已存在时按 `name (n).ext` 递增命名，
/// 与浏览器下载管理器的重名行为保持一致。
///
/// `destination` 是 WebView2 给出的默认保存路径（系统下载目录 + 文件名），
/// 父目录不存在时回退到 `%USERPROFILE%\Downloads`。
pub fn unique_download_path(destination: &Path) -> PathBuf {
    use std::env;

    let dir = match destination.parent() {
        Some(parent) if parent.is_dir() => parent.to_path_buf(),
        // 下载目录不存在（如被用户删除）时兜底到 USERPROFILE\Downloads
        _ => env::var("USERPROFILE")
            .map(PathBuf::from)
            .map(|home| home.join("Downloads"))
            .unwrap_or_else(|_| PathBuf::from(".")),
    };
    let name = destination
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    // 拆分主名与扩展名，重名时在扩展名前插入 " (n)"
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.to_string(), String::new()),
    };
    let mut counter = 0usize;
    loop {
        let candidate = if counter == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({counter}){ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

/// 递归搜索 node 二进制文件
pub fn search_node_binary(dir: &PathBuf, target: &str) -> Option<PathBuf> {
    use std::fs;

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // 递归搜索子目录
                if let Some(found) = search_node_binary(&path, target) {
                    return Some(found);
                }
            } else if path.file_name().and_then(|n| n.to_str()) == Some("node")
                || path.file_name().and_then(|n| n.to_str()) == Some("node.exe")
            {
                // 找到 node 或 node.exe 文件
                return Some(path);
            }
        }
    }

    // 如果没找到，尝试拼接目标路径
    let candidate = dir.join(target);
    if candidate.exists() {
        return Some(candidate);
    }

    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn inotify_watch_limit_is_below_recommended_minimum() {
        // 推荐最小值本身应远高于常见默认（如 65536/8192），否则提示会过早触发
        assert!(
            MIN_INOTIFY_MAX_USER_WATCHES > 65_536,
            "recommended minimum {} should exceed common defaults",
            MIN_INOTIFY_MAX_USER_WATCHES
        );
    }

    #[test]
    fn inotify_watch_limit_reads_procfs_when_present() {
        // 存在该 procfs 节点（Linux 主机）时返回 Some(>0)；不存在时返回 None。
        // 只验证类型与基本不变量，不绑定具体值，避免在不同内核配置下 flake。
        match linux_inotify_max_user_watches() {
            Some(v) => assert!(v > 0),
            None => {
                // 非 Linux / 无 procfs（CI 容器裁剪等情况）：返回 None 属预期
                println!("inotify max_user_watches not available; skipping");
            }
        }
    }
}
