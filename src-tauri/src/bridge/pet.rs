//! 桌宠相关 Tauri 命令。
//!
//! 主窗体前端的调用面：查询/切换桌宠启停、把 dsh 会话事件归一化为宠物状态写盘
//! （文件桥生产者）、枚举已安装宠物与选中宠物。

use serde::Serialize;
use tauri::AppHandle;

use crate::config;
use crate::desktop::pet;

/// 桌宠运行时状态，供侧边栏/设置页展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PetStatus {
    /// 是否启用桌宠窗口。
    pub enabled: bool,
    /// 桌宠窗口当前是否可见。
    pub visible: bool,
    /// 当前选中的宠物 id。
    pub active_pet_id: String,
}

/// 读取当前桌宠状态文件（`$DSH_HOME/pets/state.json`）。宠物窗口前端轮询此命令
/// 以驱动动画切换；文件缺失/损坏时回落默认 `idle`。
#[tauri::command]
pub fn get_pet_state(app_handle: AppHandle) -> config::PetStateFile {
    config::read_pet_state(&app_handle)
}

/// 查询桌宠启停状态。
#[tauri::command]
pub fn get_pet_status(app_handle: AppHandle) -> PetStatus {
    PetStatus {
        enabled: pet::is_pet_enabled(&app_handle),
        visible: pet::is_pet_visible(&app_handle),
        active_pet_id: pet::active_pet_id(&app_handle),
    }
}

/// 切换桌宠启用/禁用并立即同步窗口，返回更新后的状态。
#[tauri::command]
pub fn set_pet_enabled(app_handle: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.pet_enabled = enabled;
    config::set_store_dat_setting(&app_handle, setting);
    pet::sync_pet_window(&app_handle);
    Ok(PetStatus {
        enabled: pet::is_pet_enabled(&app_handle),
        visible: pet::is_pet_visible(&app_handle),
        active_pet_id: pet::active_pet_id(&app_handle),
    })
}

/// 设置当前选中的宠物 id（对应 `$DSH_HOME/pets/<id>/`）。
#[tauri::command]
pub fn set_active_pet(app_handle: AppHandle, pet_id: String) -> Result<PetStatus, String> {
    config::update_store_dat_setting(&app_handle, |setting| {
        setting.active_pet_id = pet_id;
    });
    Ok(PetStatus {
        enabled: pet::is_pet_enabled(&app_handle),
        visible: pet::is_pet_visible(&app_handle),
        active_pet_id: pet::active_pet_id(&app_handle),
    })
}

/// 把某个 dsh 会话事件归一化后的宠物状态写入状态文件（文件桥生产者）。
///
/// 主窗体前端在识别到 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
/// PostToolUseFailure / Stop / SessionEnd 等事件时调用，`state` 取 `config::pet_state`
/// 的 `PET_STATE_*` 常量。`session_id` 用于 per-session 防重放：同会话的重复事件
/// 不刷新动画时间戳。
#[tauri::command]
pub fn report_pet_activity(app_handle: AppHandle, state: String, session_id: Option<String>) -> Result<(), String> {
    config::write_pet_state(&app_handle, &state, session_id.as_deref())
        .map(|_| ())
        .map_err(|e| format!("PET_STATE_WRITE: {e}"))
}

/// 枚举 `$DSH_HOME/pets/` 下已安装的宠物目录名。
#[tauri::command]
pub fn list_pets(app_handle: AppHandle) -> Result<Vec<String>, String> {
    let dir = config::pet_state_dir_of_home(&config::get_dsh_data_path(&app_handle));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort();
    Ok(ids)
}

/// 强行显示桌宠窗口（供侧边栏「唤醒/收起」按钮；已启用才生效）。
#[tauri::command]
pub fn show_pet(app_handle: AppHandle) -> Result<(), String> {
    pet::show_pet_window(&app_handle);
    Ok(())
}

/// 隐藏桌宠窗口（侧边栏「收起」按钮）。
#[tauri::command]
pub fn hide_pet(app_handle: AppHandle) -> Result<(), String> {
    pet::hide_pet_window(&app_handle);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pet_status_default_shape() {
        // 纯结构断言：字段齐全、序列化采用 snake_case（前端契约）。
        let status = PetStatus {
            enabled: false,
            visible: false,
            active_pet_id: "cat".to_string(),
        };
        let json = serde_json::to_value(status).expect("serialize");
        assert_eq!(json["enabled"], false);
        assert_eq!(json["visible"], false);
        assert_eq!(json["active_pet_id"], "cat");
    }
}