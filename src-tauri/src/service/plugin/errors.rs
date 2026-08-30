//! 插件错误记录（持久化）。
//!
//! 记录来源：
//! - 安装/升级/卸载失败（本应用操作可确定，见 [`super::install`]）；
//! - 页面运行期异常——内嵌 dsh 页面（或 dsh-tauri 桥）经
//!   `report_plugin_error` 命令上报（见 desktop 的 iframe 消息桥）。
//!
//! 记录保存在桌面端数据目录 `plugin-errors.json`，与 `$DSH_HOME`（官方数据）
//! 分离：这是桌面端自己的诊断信息，不属于 dsh profile 数据。
//! 插件安装/升级/卸载成功时清除对应记录。

use crate::config;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

const MAX_PLUGIN_ID_BYTES: usize = 128;
const MAX_ERROR_MESSAGE_CHARS: usize = 2_000;
const MAX_ERROR_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_PLUGIN_ERROR_RECORDS: usize = 256;
const MAX_PLUGIN_ERROR_FILE_BYTES: u64 = 512 * 1024;
const ALLOWED_ACTIONS: &[&str] = &["install", "update", "remove", "runtime"];

static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 单条插件错误
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginError {
    /// 错误消息（pnpm/运行日志片段，最多保留 2000 字符）
    pub message: String,
    /// 记录动作：install / update / remove / runtime
    pub action: String,
    /// 记录时间（unix 秒级时间戳字符串）
    pub at: String,
}

/// 校验插件包名，避免把任意字符串当成插件身份或路径片段。
pub(crate) fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_PLUGIN_ID_BYTES || !id.is_ascii() {
        return Err("PLUGIN_ERROR_INVALID_ID: plugin id is not valid".to_string());
    }

    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && !segment.starts_with('.')
            && !segment.starts_with('_')
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    };

    if let Some(scoped) = id.strip_prefix('@') {
        let Some((scope, name)) = scoped.split_once('/') else {
            return Err("PLUGIN_ERROR_INVALID_ID: plugin id is not valid".to_string());
        };
        if scoped.matches('/').count() != 1 || !valid_segment(scope) || !valid_segment(name) {
            return Err("PLUGIN_ERROR_INVALID_ID: plugin id is not valid".to_string());
        }
    } else if !valid_segment(id) {
        return Err("PLUGIN_ERROR_INVALID_ID: plugin id is not valid".to_string());
    }

    Ok(())
}

/// 校验错误来源动作，持久化记录只接受固定枚举。
pub(crate) fn validate_action(action: &str) -> Result<(), String> {
    if ALLOWED_ACTIONS.contains(&action) {
        Ok(())
    } else {
        Err("PLUGIN_ERROR_INVALID_ACTION: action is not supported".to_string())
    }
}

/// 校验并规范化错误文本；超限直接拒绝，避免静默截断诊断信息。
pub(crate) fn validate_message(message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("PLUGIN_ERROR_EMPTY_MESSAGE: error message is empty".to_string());
    }
    if trimmed.chars().count() > MAX_ERROR_MESSAGE_CHARS
        || trimmed.len() > MAX_ERROR_MESSAGE_BYTES
        || trimmed.contains('\0')
    {
        return Err("PLUGIN_ERROR_MESSAGE_TOO_LONG: error message exceeds the limit".to_string());
    }
    Ok(trimmed.to_string())
}

/// 校验运行期上报输入，并返回可安全写入与广播的值。
pub(crate) fn validate_input(
    id: &str,
    action: &str,
    message: &str,
) -> Result<(String, String), String> {
    validate_plugin_id(id)?;
    validate_action(action)?;
    Ok((action.to_string(), validate_message(message)?))
}

/// 获取桌面端自己的插件错误记录文件路径。
fn errors_path(app_handle: &AppHandle) -> PathBuf {
    config::get_base_dir(app_handle).join("plugin-errors.json")
}

/// 读取全部错误记录（缺失/损坏按空处理）
pub(crate) fn load(app_handle: &AppHandle) -> HashMap<String, PluginError> {
    let path = errors_path(app_handle);
    let Ok(metadata) = fs::metadata(&path) else {
        return HashMap::new();
    };
    if metadata.len() > MAX_PLUGIN_ERROR_FILE_BYTES {
        log::warn!(
            "plugin error file exceeds {} bytes: {}",
            MAX_PLUGIN_ERROR_FILE_BYTES,
            path.display()
        );
        return HashMap::new();
    }
    let Ok(content) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let Ok(records) = serde_json::from_str::<HashMap<String, PluginError>>(&content) else {
        return HashMap::new();
    };
    if records.len() > MAX_PLUGIN_ERROR_RECORDS {
        log::warn!(
            "plugin error file exceeds {} records: {}",
            MAX_PLUGIN_ERROR_RECORDS,
            path.display()
        );
        return HashMap::new();
    }
    records
        .into_iter()
        .filter(|(id, error)| {
            validate_plugin_id(id).is_ok()
                && validate_action(&error.action).is_ok()
                && validate_message(&error.message).is_ok()
                && (error.at.is_empty()
                    || (error.at.len() <= 32 && error.at.bytes().all(|byte| byte.is_ascii_digit())))
        })
        .collect()
}

/// 将插件错误记录写入临时文件并原子替换目标文件，避免留下半写状态。
fn save(app_handle: &AppHandle, map: &HashMap<String, PluginError>) -> Result<(), String> {
    if map.len() > MAX_PLUGIN_ERROR_RECORDS {
        return Err("PLUGIN_ERRORS_LIMIT: too many plugin error records".to_string());
    }
    let path = errors_path(app_handle);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("PLUGIN_ERRORS_DIR: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(map).map_err(|e| format!("PLUGIN_ERRORS_RENDER: {e}"))?;
    if json.len() as u64 > MAX_PLUGIN_ERROR_FILE_BYTES {
        return Err("PLUGIN_ERRORS_LIMIT: plugin error file is too large".to_string());
    }

    let dir = path
        .parent()
        .ok_or_else(|| "PLUGIN_ERRORS_PATH: missing parent directory".to_string())?;
    let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!(
        ".plugin-errors.json.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("PLUGIN_ERRORS_WRITE: {error}"));
    }
    Ok(())
}

#[cfg(not(windows))]
/// 在 Unix 上用同目录重命名原子替换错误记录文件。
fn atomic_replace(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
/// 在 Windows 上用带写-through 的系统替换操作更新错误记录文件。
fn atomic_replace(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 记录插件错误（同 id 幂等覆盖）
pub fn record(app_handle: &AppHandle, id: &str, action: &str, message: &str) -> Result<(), String> {
    let (action, message) = validate_input(id, action, message)?;
    let mut map = load(app_handle);
    map.insert(
        id.to_string(),
        PluginError {
            message,
            action,
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default(),
        },
    );
    save(app_handle, &map)
}

/// 清除插件错误（安装/升级/卸载成功后）
pub fn clear(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let mut map = load(app_handle);
    if map.remove(id).is_some() {
        save(app_handle, &map)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_clear_round_trip() {
        // 不依赖 AppHandle 的纯文件读写用临时目录验证序列化形态
        let map = HashMap::from([(
            "dshmarket".to_string(),
            PluginError {
                message: "ERR_PNPM_IGNORED_BUILDS".to_string(),
                action: "install".to_string(),
                at: "1700000000".to_string(),
            },
        )]);
        let json = serde_json::to_string(&map).unwrap();
        let back: HashMap<String, PluginError> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("dshmarket").unwrap().action, "install");
        assert_eq!(
            back.get("dshmarket").unwrap().message,
            "ERR_PNPM_IGNORED_BUILDS"
        );
    }

    #[test]
    fn validation_accepts_npm_plugin_ids_and_rejects_path_like_values() {
        assert!(validate_plugin_id("dsh-notification").is_ok());
        assert!(validate_plugin_id("@deepseek-ai/dsh-base").is_ok());
        assert!(validate_plugin_id("../secret").is_err());
        assert!(validate_plugin_id("plugin\\name").is_err());
        assert!(validate_plugin_id("@scope/a/b").is_err());
    }

    #[test]
    fn validation_rejects_unknown_actions_and_oversized_messages() {
        assert!(validate_action("runtime").is_ok());
        assert!(validate_action("arbitrary").is_err());
        assert!(validate_message("  useful error  ").is_ok());
        assert!(validate_message(&"x".repeat(MAX_ERROR_MESSAGE_CHARS + 1)).is_err());
        assert!(validate_message("\0").is_err());
    }
}
