//! 启动第三方 Node 进程时的最小环境构造。
//!
//! 桌面端进程可能从终端、CI 或开发工具启动，父环境中除了路径和系统运行时信息
//! 还可能带有云凭证、代理凭证、包管理器配置和发布令牌。插件与 Harness 只接收
//! 明确需要的系统变量，调用方的额外变量也必须经过固定白名单。

use std::collections::HashMap;

const SAFE_INHERITED_KEYS: &[&str] = &[
    "APPDATA",
    "ALL_PROXY",
    "COLORTERM",
    "COMSPEC",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "LOCALAPPDATA",
    "LOGNAME",
    "NO_PROXY",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SHELL",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERPROFILE",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
];

const SAFE_EXPLICIT_KEYS: &[&str] = &[
    "ALL_PROXY",
    "DSH_HOME",
    "DSH_NODE",
    "DSH_PNPM",
    "DSH_PREFER_BUNDLED_PNPM",
    "DSH_TELEMETRY_DISABLED",
    "DSH_WEB_PORT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NO_COLOR",
    "PATH",
];

/// 将受控环境变量键规范为 ASCII 大写，便于和固定白名单比较。
fn normalized(key: &str) -> String {
    key.to_ascii_uppercase()
}

/// 判断环境变量是否可以从桌面端进程继承。
pub(crate) fn is_safe_inherited_key(key: &str) -> bool {
    let key = normalized(key);
    SAFE_INHERITED_KEYS.iter().any(|allowed| *allowed == key)
}

/// 判断环境变量是否可以由调用方显式传入子进程。
pub(crate) fn is_safe_explicit_key(key: &str) -> bool {
    let key = normalized(key);
    SAFE_EXPLICIT_KEYS.iter().any(|allowed| *allowed == key)
}

/// 保留代理配置的路由能力，但移除代理 URL 中可能泄露给子进程的账号密码。
pub(crate) fn sanitize_proxy_value(key: &str, value: &str) -> Option<String> {
    let key = normalized(key);
    if key == "NO_PROXY" {
        return Some(value.to_string());
    }
    if !matches!(key.as_str(), "ALL_PROXY" | "HTTP_PROXY" | "HTTPS_PROXY") {
        return Some(value.to_string());
    }

    let mut proxy = reqwest::Url::parse(value).ok()?;
    if proxy.username().is_empty() && proxy.password().is_none() {
        return Some(value.to_string());
    }
    proxy.set_username("").ok()?;
    proxy.set_password(None).ok()?;
    Some(proxy.to_string())
}

/// 按不区分大小写的键更新环境映射，避免 Windows 重复变量名。
fn insert_case_insensitive(map: &mut HashMap<String, String>, key: String, value: String) {
    if let Some(existing) = map
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(&key))
        .cloned()
    {
        map.insert(existing, value);
    } else {
        map.insert(key, value);
    }
}

/// 从当前进程提取系统运行所需的非敏感环境变量。
pub(crate) fn safe_environment() -> HashMap<String, String> {
    let mut environment = HashMap::new();
    for (key, value) in std::env::vars() {
        if is_safe_inherited_key(&key) {
            if let Some(value) = sanitize_proxy_value(&key, &value) {
                insert_case_insensitive(&mut environment, key, value);
            }
        }
    }
    environment
}

/// 在最小继承环境上合并调用方的受控变量，未知变量一律丢弃。
pub(crate) fn environment_with_explicit(
    extra: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut environment = safe_environment();
    for (key, value) in extra {
        if is_safe_explicit_key(key) {
            if let Some(value) = sanitize_proxy_value(key, value) {
                insert_case_insensitive(&mut environment, key.clone(), value);
            }
        }
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_allowlist_excludes_common_credentials() {
        assert!(is_safe_inherited_key("PATH"));
        assert!(is_safe_inherited_key("SystemRoot"));
        assert!(is_safe_inherited_key("HTTPS_PROXY"));
        assert!(is_safe_inherited_key("NO_PROXY"));
        assert!(!is_safe_inherited_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!is_safe_inherited_key("GITHUB_TOKEN"));
        assert!(!is_safe_inherited_key("NODE_OPTIONS"));
        assert!(!is_safe_inherited_key("NPM_CONFIG_USERCONFIG"));
    }

    #[test]
    fn proxy_configuration_is_allowed_and_credentials_are_removed() {
        assert!(is_safe_explicit_key("HTTP_PROXY"));
        assert!(is_safe_explicit_key("ALL_PROXY"));
        assert!(is_safe_explicit_key("NO_PROXY"));

        assert_eq!(
            sanitize_proxy_value("HTTPS_PROXY", "https://proxy.example:8443"),
            Some("https://proxy.example:8443".to_string())
        );
        assert_eq!(
            sanitize_proxy_value("HTTPS_PROXY", "https://alice:secret@proxy.example:8443"),
            Some("https://proxy.example:8443/".to_string())
        );
        assert_eq!(
            sanitize_proxy_value("NO_PROXY", "127.0.0.1,localhost"),
            Some("127.0.0.1,localhost".to_string())
        );
        assert!(sanitize_proxy_value("HTTPS_PROXY", "not a valid proxy").is_none());
    }

    #[test]
    fn explicit_environment_drops_unknown_keys() {
        let extra = HashMap::from([
            ("DSH_HOME".to_string(), "/tmp/dsh".to_string()),
            ("SECRET_TOKEN".to_string(), "must-not-pass".to_string()),
        ]);
        let environment = environment_with_explicit(&extra);
        assert_eq!(
            environment.get("DSH_HOME").map(String::as_str),
            Some("/tmp/dsh")
        );
        assert!(!environment.values().any(|value| value == "must-not-pass"));
    }

    #[cfg(unix)]
    #[test]
    fn explicit_environment_retains_safe_unix_runtime_settings() {
        let expected_home = std::env::var("HOME").expect("test environment should define HOME");
        let expected_path = std::env::var("PATH").expect("test environment should define PATH");
        let extra = HashMap::from([("DSH_HOME".to_string(), "/tmp/dsh".to_string())]);

        let environment = environment_with_explicit(&extra);

        assert_eq!(environment.get("HOME"), Some(&expected_home));
        assert_eq!(environment.get("PATH"), Some(&expected_path));
        assert_eq!(
            environment.get("DSH_HOME").map(String::as_str),
            Some("/tmp/dsh")
        );
    }
}
