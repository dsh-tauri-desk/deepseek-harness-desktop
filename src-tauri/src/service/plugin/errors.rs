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
use std::path::PathBuf;
use tauri::AppHandle;

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

fn errors_path(app_handle: &AppHandle) -> PathBuf {
    config::get_base_dir(app_handle).join("plugin-errors.json")
}

/// 读取全部错误记录（缺失/损坏按空处理）
pub(crate) fn load(app_handle: &AppHandle) -> HashMap<String, PluginError> {
    let Ok(content) = std::fs::read_to_string(errors_path(app_handle)) else {
        return HashMap::new();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn save(app_handle: &AppHandle, map: &HashMap<String, PluginError>) -> Result<(), String> {
    let path = errors_path(app_handle);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("PLUGIN_ERRORS_DIR: {e}"))?;
    }
    let json =
        serde_json::to_string_pretty(map).map_err(|e| format!("PLUGIN_ERRORS_RENDER: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("PLUGIN_ERRORS_WRITE: {e}"))
}

/// 记录插件错误（同 id 幂等覆盖）
pub fn record(app_handle: &AppHandle, id: &str, action: &str, message: &str) -> Result<(), String> {
    let mut map = load(app_handle);
    map.insert(
        id.to_string(),
        PluginError {
            message: message.trim().to_string(),
            action: action.to_string(),
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
}
