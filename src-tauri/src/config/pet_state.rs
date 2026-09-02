//! 桌宠状态文件桥。
//!
//! 桌宠窗口是独立 WebView（`label: "pet"`），无法与主窗体共享 iframe 内
//! BroadcastChannel/Gateway 的 dsh session 状态。这里以「落盘 state.json +
//! 轮询读取」的文件桥传递状态（模式对齐 claude-desktop-pet 的 state_watcher.rs）：
//! - **生产者（主窗体）**：把 dsh 会话生命周期事件归一化为 `PetState` 后写入
//!   `$DSH_HOME/pets/state.json`。
//! - **消费者（宠物窗口）**：轮询读该文件，根据 `PetState` 切换到对应动画。
//!
//! 状态机映射见 issue #308：
//! | dsh | 宠物状态 |
//! |-----|----------|
//! | SessionStart | idle |
//! | UserPromptSubmit | thinking |
//! | PreToolUse/PostToolUse | working |
//! | PostToolUseFailure | error |
//! | Stop | attention |
//! | SessionEnd | sleeping |

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};

use super::get_dsh_data_path;

/// 桌宠闲置状态：会话就绪、正在会话外等待下一输入。
pub const PET_STATE_IDLE: &str = "idle";
/// 思考状态：用户提交提示词，模型尚未开始调用工具。
pub const PET_STATE_THINKING: &str = "thinking";
/// 工作中：模型正在执行工具调用（PreToolUse/PostToolUse 之间）。
pub const PET_STATE_WORKING: &str = "working";
/// 出错：工具调用失败（PostToolUseFailure）。
pub const PET_STATE_ERROR: &str = "error";
/// 引起注意：会话被用户停止（Stop），提示有中断事项需要关注。
pub const PET_STATE_ATTENTION: &str = "attention";
/// 睡眠：会话结束（SessionEnd），桌宠进入休眠动画。
pub const PET_STATE_SLEEPING: &str = "sleeping";

/// 桌宠状态文件名（相对 `$DSH_HOME/pets/`）。
const PET_STATE_FILE_NAME: &str = "state.json";
/// 桌宠相关数据的目录名（相对 `$DSH_HOME`）。
const PET_DIR_NAME: &str = "pets";

/// 桌宠状态文件内容。字段全部公开，供宠物窗口直接消费。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PetStateFile {
    /// 当前状态（`PET_STATE_*` 之一）。
    pub state: String,
    /// 上次写入的 Session id；per-session 防重放（同 session 的重复事件不刷新动画）。
    pub session_id: Option<String>,
    /// 该状态的毫秒时间戳（用于宠物窗口做状态停留时长/注意力的降级）。
    pub updated_at_ms: u64,
}

impl Default for PetStateFile {
    fn default() -> Self {
        Self {
            state: PET_STATE_IDLE.to_string(),
            session_id: None,
            updated_at_ms: now_ms(),
        }
    }
}

impl PetStateFile {
    /// 归一化状态：白名单之外的任意值回落 `idle`，防止损坏或手工编辑值打乱状态机。
    pub fn normalized(mut self) -> Self {
        if !matches!(
            self.state.as_str(),
            PET_STATE_IDLE
                | PET_STATE_THINKING
                | PET_STATE_WORKING
                | PET_STATE_ERROR
                | PET_STATE_ATTENTION
                | PET_STATE_SLEEPING
        ) {
            self.state = PET_STATE_IDLE.to_string();
        }
        self
    }
}

/// 当前毫秒时间戳（Unix epoch）。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 桌宠状态文件的所在目录（`$DSH_HOME/pets/`，状态为全局单份）。
pub fn pet_state_dir_of_home(dsh_home: &Path) -> PathBuf {
    dsh_home.join(PET_DIR_NAME)
}

/// 桌宠状态文件路径（全局单份）。
pub fn pet_state_file_of_home(dsh_home: &Path) -> PathBuf {
    pet_state_dir_of_home(dsh_home).join(PET_STATE_FILE_NAME)
}

/// 读取桌宠状态：文件缺失 / 损坏（含空字符串 / 非法 JSON）时回落默认 `idle`，
/// 不因桥故障打断桌面主流程——宠物窗口是纯增强能力。
pub fn read_pet_state<R: Runtime>(app_handle: &AppHandle<R>) -> PetStateFile {
    let path = pet_state_file_of_home(&get_dsh_data_path(app_handle));
    read_pet_state_from(&path).unwrap_or_default()
}

fn read_pet_state_from(path: &Path) -> Option<PetStateFile> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PetStateFile>(&content)
        .map(PetStateFile::normalized)
        .ok()
}

/// 写桌宠状态。使用「临时文件 + 原子重命名」写，避免宠物窗口在轮询读取时读到
/// 半写状态（垮落后再读——与 ledger / store 的原子写约定一致）。
///
/// `session_id` 幂等：同 session 的重复事件不更新 `updated_at_ms`，防止高频轮询
/// 事件让宠物动画不停闪回；状态仍会写（语义一致），只是时间戳不刷新。
pub fn write_pet_state<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &str,
    session_id: Option<&str>,
) -> std::io::Result<PetStateFile> {
    let dir = pet_state_dir_of_home(&get_dsh_data_path(app_handle));
    let path = dir.join(PET_STATE_FILE_NAME);
    let previous = read_pet_state_from(&path);

    let file = PetStateFile {
        state: state.to_string(),
        session_id: session_id.map(str::to_string),
        updated_at_ms: next_updated_at_ms(previous.as_ref(), state, session_id),
    }
    .normalized();

    std::fs::create_dir_all(&dir)?;
    atomic_write_json(&path, &file)?;
    Ok(file)
}

/// 幂等时间戳决策：同 session 且同状态的事件不刷新 `updated_at_ms`（防高频轮询让
/// 宠物动画不停闪回）；其他情况刷新为当前时间。纯函数便于单测。
fn next_updated_at_ms(previous: Option<&PetStateFile>, state: &str, session_id: Option<&str>) -> u64 {
    match (previous, session_id) {
        (Some(prev), Some(id)) if prev.session_id.as_deref() == Some(id) && prev.state == state => {
            prev.updated_at_ms
        }
        _ => now_ms(),
    }
}

/// 以 「tmp + rename」 原子写 JSON 到目标路径，保证读者永远读到完整内容。
fn atomic_write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    // `-<pid>.tmp`：临时文件名带当前进程号，同作业的多实例 / 热重启不会互相抢写同一 tmp。
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state.json");
    let tmp = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, json.as_bytes())?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        // rename 同卷原子；个别平台/文件系统（如 Windows 杀软临时占用）失败时可
        // 退化为直接写，尽量避免状态桥整体不可用。
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, json.as_bytes())?;
        log::warn!("[pet] atomic rename failed, fell back to direct write: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp_dir(name: &str) -> PathBuf {
        let nonce = now_ms();
        std::env::temp_dir().join(format!(
            "dsh-pet-state-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn default_state_is_idle() {
        assert_eq!(PetStateFile::default().state, PET_STATE_IDLE);
    }

    #[test]
    fn unknown_state_normalizes_to_idle() {
        let parsed: PetStateFile =
            serde_json::from_str(r#"{"state":"party","session_id":null,"updated_at_ms":0}"#)
                .expect("deserialize");
        assert_eq!(parsed.normalized().state, PET_STATE_IDLE);
    }

    #[test]
    fn known_states_are_allowed() {
        for known in [
            PET_STATE_IDLE,
            PET_STATE_THINKING,
            PET_STATE_WORKING,
            PET_STATE_ERROR,
            PET_STATE_ATTENTION,
            PET_STATE_SLEEPING,
        ] {
            let json = format!(
                r#"{{"state":"{known}","session_id":null,"updated_at_ms":0}}"#
            );
            let parsed: PetStateFile = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(parsed.normalized().state, known);
        }
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = unique_tmp_dir("roundtrip");
        let path = dir.join(PET_STATE_FILE_NAME);
        std::fs::create_dir_all(&dir).expect("create dir");

        let file = PetStateFile {
            state: PET_STATE_WORKING.to_string(),
            session_id: Some("s1".to_string()),
            updated_at_ms: now_ms(),
        };
        atomic_write_json(&path, &file).expect("atomic write");
        let read = read_pet_state_from(&path).expect("read state file");
        assert_eq!(read.state, PET_STATE_WORKING);
        assert_eq!(read.session_id.as_deref(), Some("s1"));
        // 临时文件不应残留
        let tmp_leftovers = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .filter(|e| !e.file_name().to_string_lossy().ends_with(".json"))
            .count();
        assert_eq!(tmp_leftovers, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn same_session_same_state_does_not_refresh_timestamp() {
        let prev = PetStateFile {
            state: PET_STATE_THINKING.to_string(),
            session_id: Some("s1".to_string()),
            updated_at_ms: 1_000,
        };
        // 同 id 同状态：时间戳保持不变（per-session 防重放）。
        assert_eq!(
            next_updated_at_ms(Some(&prev), PET_STATE_THINKING, Some("s1")),
            1_000
        );
    }

    #[test]
    fn state_change_refreshes_timestamp() {
        let prev = PetStateFile {
            state: PET_STATE_THINKING.to_string(),
            session_id: Some("s1".to_string()),
            updated_at_ms: 1_000,
        };
        // 同 session 但状态变化：刷新时间戳。
        let next = next_updated_at_ms(Some(&prev), PET_STATE_WORKING, Some("s1"));
        assert!(next >= 1_000);
    }

    #[test]
    fn new_session_refreshes_timestamp() {
        let prev = PetStateFile {
            state: PET_STATE_THINKING.to_string(),
            session_id: Some("s1".to_string()),
            updated_at_ms: 1_000,
        };
        // 新 session（s2）：刷新时间戳。
        let next = next_updated_at_ms(Some(&prev), PET_STATE_THINKING, Some("s2"));
        assert!(next >= 1_000);
    }

    #[test]
    fn no_previous_state_uses_now() {
        let next = next_updated_at_ms(None, PET_STATE_IDLE, None);
        assert!(next > 0);
    }
}