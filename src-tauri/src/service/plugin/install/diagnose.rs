//! 失败输出解析：识别网络错误（代理/DNS/连接/TLS）、git 传输层失败
//! （HTTPS→SSH 回退提示），并从输出中挑选可展示的错误消息（ANSI 清洗、
//! 命中错误标记的行优先、截断）。

/// 给非空诊断文本加 `: ` 前缀，便于直接拼进错误消息（空文本返回空串）。
pub(super) fn diagnostic_suffix(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

/// 从 dsh/pnpm 失败输出中提取可展示的错误消息：优先 git 传输层提示；
/// 否则挑出命中错误标记的行（最多 8 行），没有则取输出尾部，ANSI 清洗后
/// 截断到 2000 字符。
pub(super) fn pick_error_message(output: &str, hint: Option<&str>) -> String {
    if let Some(hint) = hint {
        return hint.to_string();
    }
    let cleaned: Vec<String> = output
        .split('\n')
        .filter_map(|line| {
            let trimmed = strip_ansi(line);
            let trimmed = trimmed.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .filter(|line| {
            line.contains("ERR_")
                || line.contains("error")
                || line.contains("Error")
                || line.contains("failed")
                || line.contains("✖")
                || line.contains("warning")
        })
        .take(8)
        .collect();
    let base = if cleaned.is_empty() {
        output.trim().to_string()
    } else {
        cleaned.join("\n")
    };
    base.chars().take(2000).collect()
}

/// 去除 ANSI 转义序列（`\x1B[...m`，含颜色/样式码）。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // '['
            while let Some(&n) = chars.peek() {
                if n.is_ascii_digit() || n == ';' {
                    chars.next();
                } else {
                    break;
                }
            }
            if chars.peek() == Some(&'m') {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 从 pnpm 失败输出里识别网络错误，返回稳定提示，避免把网络问题误报为 dsh
/// 子进程错误。代理、DNS、连接超时和 TLS 失败都属于此类。
pub(super) fn network_error_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[&str] = &[
        "eai_again",
        "enotfound",
        "econnrefused",
        "econnreset",
        "etimedout",
        "network timeout",
        "network request failed",
        "fetch failed",
        "unable to verify the first certificate",
        "self signed certificate",
        "socket hang up",
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "connection reset",
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .any(|signal| lower.contains(signal))
        .then_some("网络连接失败，请检查网络或代理设置后重试。")
}

pub(super) fn git_transport_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[(&str, &str)] = &[
        (
            "host key verification failed",
            "git fell back to SSH and could not verify GitHub's host key (no known_hosts entry; the process ran non-interactively). Make sure GitHub is reachable over HTTPS.",
        ),
        (
            "permission denied (publickey)",
            "git reached GitHub over SSH instead of HTTPS (Permission denied (publickey)) — usually your git config rewrites GitHub HTTPS to SSH (url.<base>.insteadOf) while no SSH key is configured. The desktop app isolates git config to force HTTPS for plugin installs; if you still see this, remove that rewrite (git config --global --unset-all 'url.git@github.com:.insteadOf') or configure an SSH key.",
        ),
        (
            "could not read from remote repository",
            "pnpm could not read from the git remote — commonly a git+ssh transport failure. Ensure GitHub is reachable over HTTPS.",
        ),
        (
            "ssh: connect to host",
            "pnpm tried to reach GitHub over SSH (port 22) and the connection was refused. Use HTTPS instead.",
        ),
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .find(|(sig, _)| lower.contains(sig))
        .map(|(_, hint)| *hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_suffix_preserves_non_allowbuilds_failure() {
        assert_eq!(diagnostic_suffix(""), "");
        assert_eq!(
            diagnostic_suffix("ERR_PNPM_LINKING_FAILED: stale symlink"),
            ": ERR_PNPM_LINKING_FAILED: stale symlink"
        );
    }

    // ---- git 传输层错误识别（区别于 allowBuilds 门禁）----

    #[test]
    fn git_transport_hint_detects_host_key_failure() {
        let out = "git ls-remote \"git+ssh://git@github.com/foo.git\" HEAD\nHost key verification failed.\nfatal: Could not read from remote repository.\n";
        assert!(git_transport_hint(out).is_some());
    }

    #[test]
    fn git_transport_hint_detects_publickey_and_ssh() {
        assert!(git_transport_hint("git@github.com: Permission denied (publickey)").is_some());
        assert!(
            git_transport_hint("ssh: connect to host github.com port 22: Connection refused")
                .is_some()
        );
    }

    #[test]
    fn git_transport_hint_none_for_allowbuilds_output() {
        // allowBuilds 场景（prepare 构建被拦）不应误判为传输层错误
        let out = "[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ...\nallowBuilds:\n  node-pty: true\n";
        assert!(git_transport_hint(out).is_none());
    }
}
