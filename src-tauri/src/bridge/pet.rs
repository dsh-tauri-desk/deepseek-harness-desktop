//! bridge/pet.rs — 桌宠（外置透明宠物窗口）的 Tauri 命令出口。
//!
//! 这些命令被 dsh 容器（iframe 内的 dsh 界面 / dsh-tauri-pet 插件）经 invoke
//! 桥调用（壳层桥监听模块 `src/hooks/use-iframe-invoke.ts` 把 iframe 的
//! postMessage invoke 转发到 `@tauri-apps/api/core` 的 `invoke`）。所有状态
//! 读写统一落在 `config::setting`（持久化）与 `desktop::pet`（窗口）。
//! 错误遵循仓库约定：`Result<_, String>`，Err 以大写协议前缀开头（如
//! `PET_SIZE_OUT_OF_RANGE:`）。
//!
//! 实时性：一切会改变状态（开关/选择/大小）的命令都通过 `pet://status` 事件
//! 把最新 PetStatus 推给 pet 窗口——设置页拖动条拖动中实时调整宠物大小就是
//! 走这条通道；pet 窗口的 get_pet_status 轮询仅作兜底。

use crate::config;
use crate::desktop::pet as pet_window;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    http::{header::CONTENT_LENGTH, Method, Request, Response, StatusCode},
    AppHandle, Emitter, Manager,
};
use zip::ZipArchive;

/// 宠物大小百分比合法区间（精灵图缩放 50%–200%，与插件设置页滑条一致）。
pub const PET_SIZE_MIN: f64 = pet_window::PET_SIZE_MIN_PERCENT;
pub const PET_SIZE_MAX: f64 = pet_window::PET_SIZE_MAX_PERCENT;

/// 缺省选择对外统一呈现的精确内置宠物 id。
pub const DEFAULT_ACTIVE_PET_ID: &str = "maid-deepseek-whale";
/// 气泡文本最大字符数，限制跨 WebView 事件负载并避免异常大气泡遮挡屏幕。
pub const PET_BUBBLE_MAX_CHARS: usize = 280;
/// 会话实时描述最大字符数（思考/工具/需决策…），同气泡上限，防止事件负载膨胀。
pub const PET_DESCRIPTION_MAX_CHARS: usize = 280;
/// 导入桌宠资源包的压缩大小上限（32 MiB）。
const PET_PACKAGE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// 防止 zip 炸弹的条目数与解压后总大小上限。
const PET_PACKAGE_MAX_ENTRIES: usize = 512;
const PET_PACKAGE_MAX_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
/// 清单和单张精灵图的读取上限。
const PET_MANIFEST_MAX_BYTES: u64 = 64 * 1024;
const PET_SPRITESHEET_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PET_SPRITESHEET_MAX_DIMENSION: u32 = 16_384;
const PET_SPRITESHEET_MAX_PIXELS: u64 = 64 * 1024 * 1024;
const PET_SPRITE_VERSION: u8 = 2;
const PET_SPRITE_COLUMNS: u8 = 8;
const PET_SPRITE_ROWS: u8 = 11;

/// 状态变化推送给 pet 窗口的事件名（实时同步大小/选择/动作；轮询兜底）。
pub const PET_STATUS_EVENT: &str = "pet://status";

#[cfg(target_os = "windows")]
const BUILTIN_ASSET_ORIGIN: &str = "http://dsh-pet.localhost";
#[cfg(not(target_os = "windows"))]
const BUILTIN_ASSET_ORIGIN: &str = "dsh-pet://localhost";

/// 内置宠物媒体的固定白名单；资源所有权属于 dsh-tauri-pet 包，不能由前端源码
/// 相对路径直接注入桌面 bundle。
const BUILTIN_ASSET_NAMES: &[(&str, &str)] = &[
    ("idle", "maid-idle.webm"),
    ("turn", "maid-turn.webm"),
    ("move", "maid-move.webm"),
    ("wave", "maid-wave.webm"),
    ("waiting", "maid-waiting.webm"),
    ("running", "maid-running.webm"),
    ("review", "maid-review.webm"),
    ("failed", "maid-failed.webm"),
    ("bubble", "maid-bubble.webm"),
    ("fallback", "maid-deepseek-whale.gif"),
];

#[derive(Debug, Clone, Serialize)]
pub struct BuiltinPetAssets {
    pub assets: std::collections::BTreeMap<String, String>,
}

/// 桌宠动作白名单；连字符命名与视频资源和插件协议保持一致。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PetActivity {
    #[default]
    Idle,
    Turn,
    MovingLeft,
    MovingRight,
    Waving,
    Waiting,
    Running,
    Review,
    Failed,
}

impl PetActivity {
    /// 将 iframe 传入的不可信字符串严格收敛到动作白名单。
    fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "turn" => Some(Self::Turn),
            "moving-left" => Some(Self::MovingLeft),
            "moving-right" => Some(Self::MovingRight),
            "waving" => Some(Self::Waving),
            "waiting" => Some(Self::Waiting),
            "running" => Some(Self::Running),
            "review" => Some(Self::Review),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    fn is_session_activity(self) -> bool {
        matches!(self, Self::Idle | Self::Waiting | Self::Running | Self::Review | Self::Failed)
    }
}

/// 只驻留当前进程的可见性与动作；重启后恢复显示、idle 且无气泡。
#[derive(Debug, Clone)]
struct PetTransientState {
    visible: bool,
    activity: PetActivity,
    bubble: Option<String>,
    sessions: Vec<PetSessionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetSessionStatus {
    pub id: String,
    pub activity: PetActivity,
    /// 固定标题（会话名），toast title 与桌宠气泡共用。
    pub bubble: Option<String>,
    /// 实时描述（思考 / 工具 + 工具名 / 需决策…），toast description 原地刷新。
    #[serde(default)]
    pub description: Option<String>,
}

impl Default for PetTransientState {
    fn default() -> Self {
        Self {
            visible: true,
            activity: PetActivity::default(),
            bubble: None,
            sessions: Vec::new(),
        }
    }
}

fn transient_state() -> &'static Mutex<PetTransientState> {
    static STATE: OnceLock<Mutex<PetTransientState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(PetTransientState::default()))
}

/// 桌宠当前完整状态（设置页、插件与 pet 窗口读取）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetStatus {
    /// 桌宠能力是否永久启用。
    pub enabled: bool,
    /// 桌宠窗口当前是否应显示。
    pub visible: bool,
    /// 当前桌宠 id；持久值缺省或空白时始终返回内置默认 id。
    pub active_pet: String,
    /// 宠物大小百分比（50–200，100 = 精灵图原始尺寸）；None = 未设置（默认 100）。
    pub pet_size: Option<f64>,
    /// 当前瞬态动作。
    pub activity: PetActivity,
    /// 当前瞬态气泡；None 表示不展示。
    pub bubble: Option<String>,
    #[serde(default)]
    pub sessions: Vec<PetSessionStatus>,
}

/// 文件系统宠物的数据来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PetSource {
    Chat,
    Codex,
}

impl PetSource {
    /// 来源字符串是跨 iframe 的安全边界，只接受两个精确值。
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "chat" => Ok(Self::Chat),
            "codex" => Ok(Self::Codex),
            _ => Err("PET_SOURCE_INVALID: source must be chat or codex".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Codex => "codex",
        }
    }
}

/// `pet.json` 的受支持字段；缺省版本按 Codex v2 处理。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "default_sprite_version")]
    sprite_version_number: u8,
    spritesheet_path: String,
}

fn default_sprite_version() -> u8 {
    PET_SPRITE_VERSION
}

/// 列表项使用来源限定 id，避免 chat 与 codex 同名时互相覆盖。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PetListItem {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub source: String,
}

/// 实际渲染精灵图；字段保持 snake_case，与其他桌宠命令一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PetAsset {
    pub id: String,
    pub spritesheet: String,
    pub sprite_version_number: u8,
    pub columns: u8,
    pub rows: u8,
}

/// 将缺省、旧版未限定 id 或非法选择归一化为内置默认宠物的精确 id。
fn normalize_active_pet(active_pet: Option<&str>) -> String {
    let Some(id) = active_pet.map(str::trim).filter(|id| !id.is_empty()) else {
        return DEFAULT_ACTIVE_PET_ID.to_string();
    };
    if id == DEFAULT_ACTIVE_PET_ID || parse_qualified_id(id).is_ok() {
        id.to_string()
    } else {
        DEFAULT_ACTIVE_PET_ID.to_string()
    }
}

/// 校验并归一化一段可选文本：纯空白视为清空，其余保留原始排版，超长报错。
fn normalize_optional_text(
    value: Option<String>,
    max_chars: usize,
    too_long_prefix: &str,
) -> Result<Option<String>, String> {
    let value = value.and_then(|text| {
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    });
    if value.as_deref().map(|text| text.chars().count()).unwrap_or(0) > max_chars {
        return Err(format!(
            "{too_long_prefix}: text must not exceed {max_chars} characters"
        ));
    }
    Ok(value)
}

/// 校验并归一化气泡：纯空白视为清空，其余保留原始排版。
fn normalize_bubble(bubble: Option<String>) -> Result<Option<String>, String> {
    normalize_optional_text(bubble, PET_BUBBLE_MAX_CHARS, "PET_BUBBLE_TOO_LONG:")
}

/// 校验并归一化实时描述：规则同气泡，但错误前缀区分（PET_DESCRIPTION_TOO_LONG:）。
fn normalize_description(description: Option<String>) -> Result<Option<String>, String> {
    normalize_optional_text(description, PET_DESCRIPTION_MAX_CHARS, "PET_DESCRIPTION_TOO_LONG:")
}

/// 将持久设置和进程内瞬态状态合并为唯一的对外状态。
fn status_from_setting(setting: &config::Setting) -> PetStatus {
    let transient = transient_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    PetStatus {
        enabled: setting.pet_enabled,
        visible: setting.pet_enabled && transient.visible,
        active_pet: normalize_active_pet(setting.active_pet.as_deref()),
        pet_size: setting.pet_size,
        activity: transient.activity,
        bubble: transient.bubble,
        sessions: transient.sessions,
    }
}

/// 把最新状态推送给 pet 窗口（动作与设置变化共用同一事件）。
fn emit_pet_status(app: &AppHandle, status: &PetStatus) {
    let _ = app.emit_to(
        pet_window::PET_WINDOW_LABEL,
        PET_STATUS_EVENT,
        status.clone(),
    );
}

/// 查询桌宠当前完整状态。
#[tauri::command]
pub fn get_pet_status(app: AppHandle) -> PetStatus {
    status_from_setting(&config::get_store_dat_setting(&app))
}

/// 启用/停用桌宠；启用同时显示，停用同时隐藏并永久落盘。
#[tauri::command]
pub fn set_pet_enabled(app: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_enabled = enabled;
    });
    transient_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .visible = enabled;
    pet_window::set_pet_window_visible(&app, enabled)?;
    let status = status_from_setting(&updated);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 选择桌宠模型包并持久化 active_pet。
#[tauri::command]
pub fn set_active_pet(app: AppHandle, id: String) -> Result<PetStatus, String> {
    let id = id.trim().to_string();
    validate_active_pet_id(&id)?;
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.active_pet = Some(id);
    });
    let status = status_from_setting(&updated);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 设置宠物大小百分比（设置页滑条，50–200），并实时同步窗口尺寸。
#[tauri::command]
pub fn set_pet_size(app: AppHandle, size: f64) -> Result<PetStatus, String> {
    if !size.is_finite() || !(PET_SIZE_MIN..=PET_SIZE_MAX).contains(&size) {
        return Err(format!(
            "PET_SIZE_OUT_OF_RANGE: pet size percent must be within {PET_SIZE_MIN}..={PET_SIZE_MAX}"
        ));
    }
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_size = Some(size);
    });
    // 窗口尺寸由 pet WebView（知道当前资源真实画布比例）在收到状态事件后实时设置；
    // Rust 不再绕开前端重复 set_size，避免内置鲸鱼（16:9）与自定义图集比例不一致时被
    // 两处高度交替重设，造成大小变更时上下闪烁（issue #308）。DPI 变化仍由 Rust 的
    // ScaleFactorChanged 分支按当前宠物比例重设。
    let status = status_from_setting(&updated);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 更新瞬态动作与气泡；动作严格校验白名单，空气泡归一化为 None。
#[tauri::command]
pub fn set_pet_activity(
    app: AppHandle,
    activity: String,
    bubble: Option<String>,
) -> Result<PetStatus, String> {
    let activity = PetActivity::parse(activity.trim()).ok_or_else(|| {
        "PET_ACTIVITY_INVALID: activity must be idle/turn/moving-left/moving-right/waving/waiting/running/review/failed".to_string()
    })?;
    let bubble = normalize_bubble(bubble)?;
    {
        let mut transient = transient_state()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        transient.activity = activity;
        transient.bubble = bubble;
        transient.sessions.clear();
    }
    let status = status_from_setting(&config::get_store_dat_setting(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 更新完整会话快照。会话气泡是事件语义的输入，重复快照不会由 Rust 追加队列；
/// pet WebView 按稳定 session id 精确创建/关闭 Toast。
#[tauri::command]
pub fn set_pet_sessions(
    app: AppHandle,
    sessions: Vec<PetSessionStatus>,
) -> Result<PetStatus, String> {
    if sessions.len() > 128 {
        return Err("PET_SESSIONS_TOO_MANY: sessions must not exceed 128 entries".to_string());
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(sessions.len());
    for mut session in sessions {
        session.id = session.id.trim().to_string();
        if session.id.is_empty() || session.id.len() > 256 || !seen.insert(session.id.clone()) {
            return Err("PET_SESSION_ID_INVALID: session ids must be unique, non-empty, and at most 256 bytes".to_string());
        }
        if !session.activity.is_session_activity() {
            return Err("PET_SESSION_ACTIVITY_INVALID: session activity must be idle/waiting/running/review/failed".to_string());
        }
        session.bubble = normalize_bubble(session.bubble)?;
        session.description = normalize_description(session.description)?;
        normalized.push(session);
    }
    let selected = normalized
        .iter()
        .enumerate()
        .max_by_key(|(index, session)| {
            let rank = match session.activity {
                PetActivity::Failed => 5,
                PetActivity::Review => 4,
                PetActivity::Running => 3,
                PetActivity::Waiting => 2,
                PetActivity::Idle => 0,
                _ => unreachable!("session activity was validated above"),
            };
            (rank, std::cmp::Reverse(*index))
        })
        .map(|(_, session)| session)
        .cloned();
    {
        let mut transient = transient_state().lock().unwrap_or_else(|error| error.into_inner());
        transient.sessions = normalized;
        transient.activity = selected.as_ref().map(|session| session.activity).unwrap_or(PetActivity::Idle);
        transient.bubble = selected.and_then(|session| session.bubble);
    }
    let status = status_from_setting(&config::get_store_dat_setting(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 按物理像素增量移动桌宠窗口，限制在可见显示器并保存最终位置。
#[tauri::command]
pub fn move_pet_window(app: AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    pet_window::move_pet_window(&app, delta_x, delta_y)
}

/// 显示桌宠窗口；只允许已永久启用的桌宠恢复显示。
#[tauri::command]
pub fn show_pet(app: AppHandle) -> Result<PetStatus, String> {
    let setting = config::get_store_dat_setting(&app);
    if !setting.pet_enabled {
        return Err("PET_DISABLED: pet window is not enabled".to_string());
    }
    transient_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .visible = true;
    pet_window::set_pet_window_visible(&app, true)?;
    let status = status_from_setting(&setting);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 临时隐藏桌宠窗口，不改变永久 enabled；重启后已启用宠物重新显示。
#[tauri::command]
pub fn hide_pet(app: AppHandle) -> Result<PetStatus, String> {
    transient_state()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .visible = false;
    pet_window::set_pet_window_visible(&app, false)?;
    let status = status_from_setting(&config::get_store_dat_setting(&app));
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 返回来源对应的真实目录；chat 直接使用 `$DSH_HOME/pets`，codex 直接使用
/// 用户主目录下的 `.codex/pets`，均不经过应用 AppData。
fn pets_dir(app: &AppHandle, source: PetSource) -> Result<PathBuf, String> {
    match source {
        PetSource::Chat => Ok(config::get_dsh_data_path(app).join("pets")),
        PetSource::Codex => app
            .path()
            .home_dir()
            .map(|home| home.join(".codex").join("pets"))
            .map_err(|error| format!("PET_HOME_DIR_FAILED: failed to resolve home dir: {error}")),
    }
}

fn valid_manifest_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

fn validate_manifest_id(id: &str) -> Result<(), String> {
    if valid_manifest_id(id) {
        Ok(())
    } else {
        Err("PET_ID_INVALID: manifest id must be 1..=64 ascii letters/digits/-/_".to_string())
    }
}

fn qualified_id(source: PetSource, manifest_id: &str) -> String {
    format!("{}:{manifest_id}", source.as_str())
}

fn parse_qualified_id(id: &str) -> Result<(PetSource, &str), String> {
    let (source, manifest_id) = id
        .split_once(':')
        .ok_or_else(|| "PET_ID_INVALID: filesystem pet id must be source-qualified".to_string())?;
    let source = PetSource::parse(source)?;
    validate_manifest_id(manifest_id)?;
    Ok((source, manifest_id))
}

fn validate_active_pet_id(id: &str) -> Result<(), String> {
    if id == DEFAULT_ACTIVE_PET_ID {
        return Ok(());
    }
    parse_qualified_id(id).map(|_| ())
}

/// 路径只允许普通相对组件；显式拒绝反斜杠和冒号，以便 Unix 上的校验结果也能
/// 覆盖 Windows 的目录分隔符、盘符与 NTFS ADS 语义。
fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') || value.contains(':') {
        return Err("PET_PATH_INVALID: path must be a portable relative path".to_string());
    }
    let mut result = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) if !part.is_empty() => result.push(part),
            _ => {
                return Err(
                    "PET_PATH_INVALID: path must not be absolute or contain traversal".to_string(),
                )
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err("PET_PATH_INVALID: path must not be empty".to_string());
    }
    Ok(result)
}

/// 限量读取文件，避免列表缩略图和渲染接口把异常大文件塞进 IPC。
fn read_bounded_file(path: &Path, limit: u64, prefix: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{prefix}: {} is not a file", path.display()));
    }
    if metadata.len() > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    Ok(bytes)
}

fn parse_manifest_bytes(bytes: &[u8]) -> Result<PetManifest, String> {
    let manifest: PetManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("PET_MANIFEST_INVALID: invalid pet.json: {error}"))?;
    validate_manifest_id(&manifest.id)?;
    if manifest.sprite_version_number != PET_SPRITE_VERSION {
        return Err(format!(
            "PET_SPRITE_VERSION_UNSUPPORTED: spriteVersionNumber must be {PET_SPRITE_VERSION}"
        ));
    }
    safe_relative_path(&manifest.spritesheet_path)?;
    Ok(manifest)
}

fn read_manifest(directory: &Path) -> Result<PetManifest, String> {
    let bytes = read_bounded_file(
        &directory.join("pet.json"),
        PET_MANIFEST_MAX_BYTES,
        "PET_MANIFEST_READ_FAILED",
    )?;
    parse_manifest_bytes(&bytes)
}

/// 跟随符号链接后仍必须留在宠物目录中；导入包本身则会更早直接拒绝链接条目。
fn contained_file(directory: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = safe_relative_path(relative)?;
    let root = directory.canonicalize().map_err(|error| {
        format!(
            "PET_ASSET_READ_FAILED: failed to resolve {}: {error}",
            directory.display()
        )
    })?;
    let candidate = directory
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("PET_ASSET_READ_FAILED: failed to resolve asset: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("PET_PATH_INVALID: spritesheetPath escapes the pet directory".to_string());
    }
    Ok(candidate)
}

fn spritesheet_dimensions(bytes: &[u8]) -> Result<(&'static str, u32, u32), String> {
    let (mime, width, height) = if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if &bytes[12..16] != b"IHDR" {
            return Err("PET_ASSET_FORMAT_INVALID: PNG is missing IHDR".to_string());
        }
        (
            "image/png",
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    } else if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let chunk = &bytes[12..16];
        let (width, height) = match chunk {
            b"VP8X" if bytes.len() >= 30 => (
                1 + u32::from(bytes[24])
                    + (u32::from(bytes[25]) << 8)
                    + (u32::from(bytes[26]) << 16),
                1 + u32::from(bytes[27])
                    + (u32::from(bytes[28]) << 8)
                    + (u32::from(bytes[29]) << 16),
            ),
            b"VP8L" if bytes.len() >= 25 && bytes[20] == 0x2f => (
                1 + u32::from(bytes[21]) + ((u32::from(bytes[22]) & 0x3f) << 8),
                1 + (u32::from(bytes[22]) >> 6)
                    + (u32::from(bytes[23]) << 2)
                    + ((u32::from(bytes[24]) & 0x0f) << 10),
            ),
            b"VP8 " if bytes.len() >= 30 && bytes[23..26] == [0x9d, 0x01, 0x2a] => (
                u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff),
                u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff),
            ),
            _ => {
                return Err(
                    "PET_ASSET_FORMAT_INVALID: unsupported or malformed WebP header".to_string(),
                )
            }
        };
        ("image/webp", width, height)
    } else {
        return Err("PET_ASSET_FORMAT_INVALID: spritesheet must be PNG or WebP".to_string());
    };

    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > PET_SPRITESHEET_MAX_DIMENSION
        || height > PET_SPRITESHEET_MAX_DIMENSION
        || pixels > PET_SPRITESHEET_MAX_PIXELS
    {
        return Err(format!(
            "PET_ASSET_DIMENSIONS_INVALID: spritesheet dimensions exceed {PET_SPRITESHEET_MAX_DIMENSION}px or {PET_SPRITESHEET_MAX_PIXELS} pixels"
        ));
    }
    if width % u32::from(PET_SPRITE_COLUMNS) != 0 || height % u32::from(PET_SPRITE_ROWS) != 0 {
        return Err(format!(
            "PET_ASSET_DIMENSIONS_INVALID: v2 spritesheet must be divisible by {PET_SPRITE_COLUMNS} columns and {PET_SPRITE_ROWS} rows"
        ));
    }
    Ok((mime, width, height))
}

fn image_data_url(directory: &Path, relative: &str) -> Result<String, String> {
    let path = contained_file(directory, relative)?;
    let bytes = read_bounded_file(&path, PET_SPRITESHEET_MAX_BYTES, "PET_ASSET_READ_FAILED")?;
    let (mime, _, _) = spritesheet_dimensions(&bytes)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn manifest_to_list_item(
    source: PetSource,
    directory: &Path,
    manifest: PetManifest,
) -> PetListItem {
    let name = manifest
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&manifest.id)
        .to_string();
    let description = manifest
        .description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let thumbnail = image_data_url(directory, &manifest.spritesheet_path).ok();
    PetListItem {
        id: qualified_id(source, &manifest.id),
        name,
        description,
        thumbnail,
        source: source.as_str().to_string(),
    }
}

fn immediate_pet_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "PET_LIST_FAILED: failed to read {}: {error}",
                root.display()
            ))
        }
    };
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            directories.push(entry.path());
        }
    }
    directories.sort();
    Ok(directories)
}

/// 列出指定来源目录中的清单。损坏的单个宠物会被忽略，不阻断其余可用宠物。
#[tauri::command]
pub fn list_pets(app: AppHandle, source: String) -> Result<Vec<PetListItem>, String> {
    let source = PetSource::parse(source.trim())?;
    let root = pets_dir(&app, source)?;
    let mut items = Vec::new();
    let mut ids = HashSet::new();
    for directory in immediate_pet_directories(&root)? {
        let Ok(manifest) = read_manifest(&directory) else {
            continue;
        };
        let id = qualified_id(source, &manifest.id);
        if ids.insert(id) {
            items.push(manifest_to_list_item(source, &directory, manifest));
        }
    }
    items.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(items)
}

fn find_pet_directory(
    root: &Path,
    manifest_id: &str,
) -> Result<Option<(PathBuf, PetManifest)>, String> {
    for directory in immediate_pet_directories(root)? {
        let Ok(manifest) = read_manifest(&directory) else {
            continue;
        };
        if manifest.id == manifest_id {
            return Ok(Some((directory, manifest)));
        }
    }
    Ok(None)
}

fn builtin_asset_file(name: &str) -> Option<(&'static str, &'static str)> {
    BUILTIN_ASSET_NAMES
        .iter()
        .find(|(key, file)| *key == name || *file == name)
        .map(|(_, file)| {
            let mime = if file.ends_with(".webm") {
                "video/webm"
            } else {
                "image/gif"
            };
            (*file, mime)
        })
}

fn resolve_builtin_asset_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let plugin = crate::service::plugin::bundled_plugin_dir(app, "dsh-tauri-pet")
        .ok_or_else(|| "PET_BUILTIN_ASSET_NOT_FOUND: dsh-tauri-pet is not deployed".to_string())?;
    let assets_root = plugin.join("assets").canonicalize().map_err(|error| {
        format!("PET_BUILTIN_ASSET_ROOT_FAILED: failed to resolve assets directory: {error}")
    })?;
    let candidate = assets_root.join(file);
    let link_metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        format!("PET_BUILTIN_ASSET_READ_FAILED: failed to inspect {}: {error}", candidate.display())
    })?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(format!(
            "PET_BUILTIN_ASSET_INVALID: {} is not a regular file",
            candidate.display()
        ));
    }
    let resolved = candidate.canonicalize().map_err(|error| {
        format!("PET_BUILTIN_ASSET_READ_FAILED: failed to resolve {}: {error}", candidate.display())
    })?;
    if !resolved.starts_with(&assets_root) {
        return Err("PET_BUILTIN_ASSET_INVALID: asset escapes dsh-tauri-pet/assets".to_string());
    }
    let metadata = fs::metadata(&resolved).map_err(|error| {
        format!("PET_BUILTIN_ASSET_READ_FAILED: failed to inspect {}: {error}", resolved.display())
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "PET_BUILTIN_ASSET_INVALID: {} is not a regular file",
            resolved.display()
        ));
    }
    if metadata.len() > PET_SPRITESHEET_MAX_BYTES {
        return Err(format!(
            "PET_BUILTIN_ASSET_TOO_LARGE: {} exceeds {PET_SPRITESHEET_MAX_BYTES} bytes",
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn protocol_error(status: StatusCode, error: &str) -> Response<Vec<u8>> {
    log::warn!("{error}");
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(error.as_bytes().to_vec())
        .unwrap()
}

/// 从不同平台的自定义协议请求路径中提取单一资源名。Windows WebView 有时会
/// 把 authority 规范化进 path（`/localhost/idle`），因此这里兼容该表示，仍只
/// 接受固定白名单，不能借此访问任意目录。
fn builtin_asset_name(path: &str) -> Option<&str> {
    let path = path.trim_matches('/');
    let name = path.strip_prefix("localhost/").unwrap_or(path);
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains(':') || name.contains("..") {
        return None;
    }
    Some(name)
}

/// 受控内置媒体的 URL manifest；实际字节由 dsh-pet 协议按需流式提供。
#[tauri::command]
pub fn get_builtin_pet_assets() -> BuiltinPetAssets {
    let assets = BUILTIN_ASSET_NAMES
        .iter()
        .map(|(key, file)| ((*key).to_string(), format!("{BUILTIN_ASSET_ORIGIN}/{file}")))
        .collect();
    BuiltinPetAssets { assets }
}

/// 为 dsh-pet 自定义协议读取固定白名单资源；调用方已在 builder 中限制为 pet WebView。
pub fn builtin_pet_asset_response(
    app: &AppHandle,
    webview_label: &str,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if webview_label != pet_window::PET_WINDOW_LABEL {
        return protocol_error(StatusCode::FORBIDDEN, "PET_BUILTIN_ASSET_FORBIDDEN: request is not from pet window");
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return protocol_error(StatusCode::METHOD_NOT_ALLOWED, "PET_BUILTIN_ASSET_METHOD_INVALID: only GET and HEAD are allowed");
    }
    let Some(name) = builtin_asset_name(request.uri().path()) else {
        return protocol_error(StatusCode::FORBIDDEN, "PET_BUILTIN_ASSET_PATH_INVALID: path is not a safe asset name");
    };
    let Some((file_name, mime)) = builtin_asset_file(name) else {
        return protocol_error(StatusCode::NOT_FOUND, "PET_BUILTIN_ASSET_NOT_FOUND: asset is not in the built-in whitelist");
    };
    let path = match resolve_builtin_asset_path(app, file_name) {
        Ok(path) => path,
        Err(error) => return protocol_error(StatusCode::NOT_FOUND, &error),
    };
    let Ok(file) = fs::File::open(&path) else {
        return protocol_error(StatusCode::NOT_FOUND, "PET_BUILTIN_ASSET_READ_FAILED: asset could not be opened");
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return protocol_error(StatusCode::NOT_FOUND, "PET_BUILTIN_ASSET_READ_FAILED: asset metadata unavailable");
    };
    let base = Response::builder()
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes");
    if request.method() == Method::HEAD {
        return base.header(CONTENT_LENGTH, length).status(StatusCode::OK).body(Vec::new()).unwrap();
    }
    let Some(range) = request.headers().get("range").and_then(|value| value.to_str().ok()) else {
        let mut bytes = Vec::new();
        let mut limited = file.take(PET_SPRITESHEET_MAX_BYTES.saturating_add(1));
        if limited.read_to_end(&mut bytes).is_err() || bytes.len() as u64 > PET_SPRITESHEET_MAX_BYTES {
            return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(Vec::new()).unwrap();
        }
        return base.header(CONTENT_LENGTH, bytes.len()).status(StatusCode::OK).body(bytes).unwrap();
    };
    let Some((start, end)) = parse_single_byte_range(range, length) else {
        return base.header("Content-Range", format!("bytes */{length}")).status(StatusCode::RANGE_NOT_SATISFIABLE).body(Vec::new()).unwrap();
    };
    let size = end - start + 1;
    let Ok(capacity) = usize::try_from(size) else {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).body(Vec::new()).unwrap();
    };
    let mut bytes = vec![0; capacity];
    let mut file = file;
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut bytes).is_err() {
        return Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()).unwrap();
    }
    base.header(CONTENT_LENGTH, size)
        .header("Content-Range", format!("bytes {start}-{end}/{length}"))
        .status(StatusCode::PARTIAL_CONTENT)
        .body(bytes)
        .unwrap()
}

fn parse_single_byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 || length == 0 { return None; }
        return Some((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length { return None; }
    let end = if end.is_empty() { length - 1 } else { end.parse::<u64>().ok()?.min(length - 1) };
    (end >= start).then_some((start, end))
}

/// 按来源限定 id 读取真实精灵图。
#[tauri::command]
pub fn get_pet_asset(app: AppHandle, id: String) -> Result<PetAsset, String> {
    let id = id.trim();
    let (source, manifest_id) = parse_qualified_id(id)?;
    let root = pets_dir(&app, source)?;
    let (directory, manifest) = find_pet_directory(&root, manifest_id)?.ok_or_else(|| {
        format!(
            "PET_NOT_FOUND: pet {} was not found",
            qualified_id(source, manifest_id)
        )
    })?;
    let spritesheet = image_data_url(&directory, &manifest.spritesheet_path)?;
    Ok(PetAsset {
        id: qualified_id(source, &manifest.id),
        spritesheet,
        sprite_version_number: PET_SPRITE_VERSION,
        columns: PET_SPRITE_COLUMNS,
        rows: PET_SPRITE_ROWS,
    })
}

fn pet_import_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// zip 条目额外拒绝符号链接与其他特殊 Unix 文件类型。
fn safe_archive_entry(name: &str, unix_mode: Option<u32>) -> Result<PathBuf, String> {
    if let Some(mode) = unix_mode {
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o040000 && file_type != 0o100000 {
            return Err("PET_ARCHIVE_LINK_FORBIDDEN: archive links are not allowed".to_string());
        }
    }
    safe_relative_path(name.trim_end_matches('/'))
}

fn archive_root_prefix(paths: &[(PathBuf, bool)]) -> Result<Option<PathBuf>, String> {
    let manifests = paths
        .iter()
        .filter(|(path, is_dir)| {
            !is_dir && path.file_name().and_then(|value| value.to_str()) == Some("pet.json")
        })
        .map(|(path, _)| path)
        .collect::<Vec<_>>();
    if manifests.len() != 1 {
        return Err(
            "PET_ARCHIVE_LAYOUT_INVALID: archive must contain exactly one pet.json".to_string(),
        );
    }
    let manifest = manifests[0];
    if manifest == Path::new("pet.json") {
        return Ok(None);
    }
    let prefix = manifest.parent().filter(|parent| parent.components().count() == 1)
        .ok_or_else(|| {
            "PET_ARCHIVE_LAYOUT_INVALID: archive must contain pet.json at root or in one wrapper directory"
                .to_string()
        })?
        .to_path_buf();
    if paths
        .iter()
        .any(|(path, _)| path != &prefix && !path.starts_with(&prefix))
    {
        return Err(
            "PET_ARCHIVE_LAYOUT_INVALID: archive must have exactly one supported root".to_string(),
        );
    }
    Ok(Some(prefix))
}

/// 流式复制时按实际解压字节数截断，不能只信任 zip 中声明的文件大小。
fn copy_archive_entry<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total: &mut u64,
    limit: u64,
) -> Result<(), String> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = limit.saturating_sub(*total);
        if remaining == 0 {
            let mut probe = [0_u8; 1];
            let count = reader.read(&mut probe).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to read archive entry: {error}")
            })?;
            if count == 0 {
                return Ok(());
            }
            return Err(format!(
                "PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed {limit} bytes"
            ));
        }
        let chunk_limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let count = reader.read(&mut buffer[..chunk_limit]).map_err(|error| {
            format!("PET_ARCHIVE_EXTRACT_FAILED: failed to read archive entry: {error}")
        })?;
        if count == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..count]).map_err(|error| {
            format!("PET_ARCHIVE_EXTRACT_FAILED: failed to write archive entry: {error}")
        })?;
        *total = total
            .checked_add(count as u64)
            .ok_or_else(|| "PET_ARCHIVE_TOO_LARGE: uncompressed size overflow".to_string())?;
    }
}

/// 两遍处理 zip：先完整验证路径、类型和声明大小，再向 staging 写入。
fn extract_pet_archive(bytes: &[u8], staging: &Path) -> Result<PetManifest, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to open zip: {error}"))?;
    if archive.len() == 0 || archive.len() > PET_PACKAGE_MAX_ENTRIES {
        return Err(format!(
            "PET_ARCHIVE_ENTRY_LIMIT: archive must contain 1..={PET_PACKAGE_MAX_ENTRIES} entries"
        ));
    }

    let mut paths = Vec::with_capacity(archive.len());
    let mut declared_total = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to read entry: {error}"))?;
        let path = safe_archive_entry(file.name(), file.unix_mode())?;
        let is_dir = file.is_dir();
        if !is_dir {
            declared_total = declared_total
                .checked_add(file.size())
                .ok_or_else(|| "PET_ARCHIVE_TOO_LARGE: uncompressed size overflow".to_string())?;
            if declared_total > PET_PACKAGE_MAX_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "PET_ARCHIVE_TOO_LARGE: uncompressed files must not exceed {PET_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes"
                ));
            }
        }
        paths.push((path, is_dir));
    }
    let prefix = archive_root_prefix(&paths)?;

    fs::create_dir(staging).map_err(|error| {
        format!("PET_IMPORT_STAGING_FAILED: failed to create staging directory: {error}")
    })?;
    let mut outputs = HashSet::new();
    let mut actual_total = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("PET_ARCHIVE_INVALID: failed to read entry: {error}"))?;
        let path = safe_archive_entry(file.name(), file.unix_mode())?;
        let relative = match prefix.as_deref() {
            Some(wrapper) if path == wrapper => continue,
            Some(wrapper) => path.strip_prefix(wrapper).map_err(|_| {
                "PET_ARCHIVE_LAYOUT_INVALID: entry is outside wrapper directory".to_string()
            })?,
            None => path.as_path(),
        };
        if relative.as_os_str().is_empty() || !outputs.insert(relative.to_path_buf()) {
            if relative.as_os_str().is_empty() {
                continue;
            }
            return Err("PET_ARCHIVE_DUPLICATE_ENTRY: duplicate output path".to_string());
        }
        let output_path = staging.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|error| {
                format!("PET_ARCHIVE_EXTRACT_FAILED: failed to create file: {error}")
            })?;
        copy_archive_entry(
            &mut file,
            &mut output,
            &mut actual_total,
            PET_PACKAGE_MAX_UNCOMPRESSED_BYTES,
        )?;
    }

    let manifest = read_manifest(staging)?;
    image_data_url(staging, &manifest.spritesheet_path)?;
    Ok(manifest)
}

fn unique_staging_path(staging_root: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    staging_root.join(format!("import-{}-{nonce}", std::process::id()))
}

fn prepare_staging_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|error| {
        format!("PET_DIR_FAILED: failed to create Codex pets directory: {error}")
    })?;
    let staging_root = root.join(".staging");
    match fs::symlink_metadata(&staging_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("PET_IMPORT_STAGING_FAILED: .staging must be a real directory".to_string())
        }
        Ok(_) => Ok(staging_root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&staging_root).map_err(|error| {
                format!("PET_IMPORT_STAGING_FAILED: failed to create staging directory: {error}")
            })?;
            Ok(staging_root)
        }
        Err(error) => Err(format!(
            "PET_IMPORT_STAGING_FAILED: failed to inspect staging directory: {error}"
        )),
    }
}

fn path_exists_including_symlink(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "PET_IMPORT_COMMIT_FAILED: failed to inspect target: {error}"
        )),
    }
}

/// 导入 Codex v2 宠物：上传文件名不参与安装路径，只在 `~/.codex/pets` 内按清单 id 提交。
#[tauri::command]
pub fn import_pet(app: AppHandle, name: String, data: String) -> Result<PetListItem, String> {
    // 前端协议仍携带文件名，但文件名可能含 Unicode/空格且属于不可信展示数据。
    let _ = name;
    let encoded_limit = PET_PACKAGE_MAX_BYTES.div_ceil(3) * 4;
    if data.len() > encoded_limit {
        return Err(format!(
            "PET_PACKAGE_TOO_LARGE: pet package must not exceed {PET_PACKAGE_MAX_BYTES} compressed bytes"
        ));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| format!("PET_PACKAGE_DECODE_FAILED: invalid base64 payload: {error}"))?;
    if bytes.len() > PET_PACKAGE_MAX_BYTES {
        return Err(format!(
            "PET_PACKAGE_TOO_LARGE: pet package must not exceed {PET_PACKAGE_MAX_BYTES} compressed bytes"
        ));
    }

    let root = pets_dir(&app, PetSource::Codex)?;
    let _guard = pet_import_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let staging_root = prepare_staging_root(&root)?;
    let staging = unique_staging_path(&staging_root);
    let result = (|| {
        let manifest = extract_pet_archive(&bytes, &staging)?;
        let target = root.join(&manifest.id);
        if path_exists_including_symlink(&target)? {
            return Err(format!(
                "PET_ALREADY_IMPORTED: Codex pet target {} already exists",
                manifest.id
            ));
        }
        if let Some((existing, _)) = find_pet_directory(&root, &manifest.id)? {
            return Err(format!(
                "PET_ALREADY_IMPORTED: Codex pet id {} already exists at {}",
                manifest.id,
                existing.display()
            ));
        }
        fs::rename(&staging, &target).map_err(|error| {
            format!("PET_IMPORT_COMMIT_FAILED: failed to install Codex pet: {error}")
        })?;
        Ok(manifest_to_list_item(PetSource::Codex, &target, manifest))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::FileOptions;
    use zip::CompressionMethod;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            Self(
                std::env::temp_dir().join(format!("dsh-pet-{name}-{}-{nonce}", std::process::id())),
            )
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn build_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn valid_test_webp() -> Vec<u8> {
        let mut bytes = b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00".to_vec();
        bytes.extend_from_slice(&[87, 0, 0, 87, 0, 0]);
        bytes
    }

    #[test]
    fn active_pet_defaults_to_exact_builtin_id() {
        assert_eq!(normalize_active_pet(None), DEFAULT_ACTIVE_PET_ID);
        assert_eq!(normalize_active_pet(Some("   ")), DEFAULT_ACTIVE_PET_ID);
        assert_eq!(
            normalize_active_pet(Some(" chat:custom-pet ")),
            "chat:custom-pet",
            "有效 id 应只去除首尾空白"
        );
        assert_eq!(
            normalize_active_pet(Some("codex:custom_pet")),
            "codex:custom_pet"
        );
        for legacy_or_invalid in ["cat", "shiba", "other:pet", "chat:../pet"] {
            assert_eq!(
                normalize_active_pet(Some(legacy_or_invalid)),
                DEFAULT_ACTIVE_PET_ID,
                "旧版或非法 id {legacy_or_invalid} 应回落内置宠物"
            );
        }
    }

    #[test]
    fn pet_activity_accepts_only_protocol_whitelist() {
        for activity in [
            "idle",
            "turn",
            "moving-left",
            "moving-right",
            "waving",
            "waiting",
            "running",
            "review",
            "failed",
        ] {
            assert!(PetActivity::parse(activity).is_some(), "应接受 {activity}");
        }
        for activity in ["move", "MovingLeft", "idle ", "success", ""] {
            assert!(
                PetActivity::parse(activity).is_none(),
                "不应接受 {activity}"
            );
        }
    }

    #[test]
    fn pet_activity_serializes_with_kebab_case() {
        assert_eq!(
            serde_json::to_string(&PetActivity::MovingLeft).unwrap(),
            "\"moving-left\""
        );
        assert_eq!(
            serde_json::to_string(&PetActivity::MovingRight).unwrap(),
            "\"moving-right\""
        );
    }

    #[test]
    fn bubble_validation_counts_unicode_characters() {
        assert_eq!(normalize_bubble(Some("  ".to_string())).unwrap(), None);
        let max = "鲸".repeat(PET_BUBBLE_MAX_CHARS);
        assert_eq!(normalize_bubble(Some(max.clone())).unwrap(), Some(max));
        let error = normalize_bubble(Some("鲸".repeat(PET_BUBBLE_MAX_CHARS + 1))).unwrap_err();
        assert!(error.starts_with("PET_BUBBLE_TOO_LONG:"));
    }

    #[test]
    fn description_validation_counts_unicode_and_prefixes_error() {
        assert_eq!(normalize_description(Some("  ".to_string())).unwrap(), None);
        let max = "思".repeat(PET_DESCRIPTION_MAX_CHARS);
        assert_eq!(normalize_description(Some(max.clone())).unwrap(), Some(max));
        let error = normalize_description(Some("思".repeat(PET_DESCRIPTION_MAX_CHARS + 1))).unwrap_err();
        assert!(error.starts_with("PET_DESCRIPTION_TOO_LONG:"));
    }

    #[test]
    fn status_never_reports_visible_when_disabled() {
        let setting = config::Setting {
            pet_enabled: false,
            ..Default::default()
        };
        let status = status_from_setting(&setting);
        assert!(!status.enabled);
        assert!(!status.visible);
        assert_eq!(status.active_pet, DEFAULT_ACTIVE_PET_ID);
    }

    #[test]
    fn manifest_parsing_defaults_to_v2_and_qualifies_source_ids() {
        let manifest = parse_manifest_bytes(
            br#"{"id":"blue_whale","displayName":"Blue Whale","description":"Chat pet","spritesheetPath":"art/pet.webp"}"#,
        )
        .unwrap();
        assert_eq!(manifest.sprite_version_number, 2);
        assert_eq!(
            qualified_id(PetSource::Chat, &manifest.id),
            "chat:blue_whale"
        );
        assert_eq!(
            qualified_id(PetSource::Codex, &manifest.id),
            "codex:blue_whale"
        );
    }

    #[test]
    fn manifest_rejects_invalid_ids_and_non_v2_sprites() {
        let invalid_id =
            parse_manifest_bytes(br#"{"id":"../pet","spritesheetPath":"spritesheet.webp"}"#)
                .unwrap_err();
        assert!(invalid_id.starts_with("PET_ID_INVALID:"));
        let v1 = parse_manifest_bytes(
            br#"{"id":"legacy","spriteVersionNumber":1,"spritesheetPath":"spritesheet.webp"}"#,
        )
        .unwrap_err();
        assert!(v1.starts_with("PET_SPRITE_VERSION_UNSUPPORTED:"));
    }

    #[test]
    fn qualified_ids_require_known_source_and_safe_manifest_id() {
        assert_eq!(
            parse_qualified_id("chat:pet_1").unwrap(),
            (PetSource::Chat, "pet_1")
        );
        assert!(parse_qualified_id("pet_1")
            .unwrap_err()
            .starts_with("PET_ID_INVALID:"));
        assert!(parse_qualified_id("other:pet_1")
            .unwrap_err()
            .starts_with("PET_SOURCE_INVALID:"));
        assert!(parse_qualified_id("codex:../pet")
            .unwrap_err()
            .starts_with("PET_ID_INVALID:"));
    }

    #[test]
    fn archive_paths_reject_traversal_absolute_windows_and_links() {
        for path in [
            "../escape",
            "/absolute",
            "a/../../escape",
            "C:/escape",
            "..\\escape",
        ] {
            assert!(
                safe_archive_entry(path, Some(0o100644)).is_err(),
                "应拒绝 {path}"
            );
        }
        assert!(safe_archive_entry("pet/spritesheet.webp", Some(0o100644)).is_ok());
        assert!(safe_archive_entry("pet/link", Some(0o120777))
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LINK_FORBIDDEN:"));
    }

    #[test]
    fn archive_layout_accepts_root_or_one_wrapper_only() {
        let root = vec![
            (PathBuf::from("pet.json"), false),
            (PathBuf::from("spritesheet.webp"), false),
        ];
        assert_eq!(archive_root_prefix(&root).unwrap(), None);

        let wrapped = vec![
            (PathBuf::from("my-pet"), true),
            (PathBuf::from("my-pet/pet.json"), false),
            (PathBuf::from("my-pet/spritesheet.webp"), false),
        ];
        assert_eq!(
            archive_root_prefix(&wrapped).unwrap(),
            Some(PathBuf::from("my-pet"))
        );

        let mixed = vec![
            (PathBuf::from("my-pet/pet.json"), false),
            (PathBuf::from("outside.txt"), false),
        ];
        assert!(archive_root_prefix(&mixed)
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LAYOUT_INVALID:"));

        let duplicate_manifests = vec![
            (PathBuf::from("pet.json"), false),
            (PathBuf::from("wrapper/pet.json"), false),
        ];
        assert!(archive_root_prefix(&duplicate_manifests)
            .unwrap_err()
            .starts_with("PET_ARCHIVE_LAYOUT_INVALID:"));
    }

    #[test]
    fn bounded_copy_stops_before_writing_past_total_limit() {
        let mut reader = Cursor::new(vec![7_u8; 6]);
        let mut output = Vec::new();
        let mut total = 3_u64;
        let error = copy_archive_entry(&mut reader, &mut output, &mut total, 8).unwrap_err();
        assert!(error.starts_with("PET_ARCHIVE_TOO_LARGE:"));
        assert_eq!(total, 8);
        assert_eq!(output.len(), 5, "不得把超过总上限的字节写入 staging");
    }

    #[test]
    fn spritesheet_dimensions_require_v2_grid_and_bounds() {
        let valid = valid_test_webp();
        assert_eq!(
            spritesheet_dimensions(&valid).unwrap(),
            ("image/webp", 88, 88)
        );

        let mut invalid_grid = valid.clone();
        invalid_grid[24] = 86;
        assert!(spritesheet_dimensions(&invalid_grid)
            .unwrap_err()
            .starts_with("PET_ASSET_DIMENSIONS_INVALID:"));

        let mut oversized = valid;
        oversized[24..27].copy_from_slice(&[0xff, 0xff, 0x00]);
        assert!(spritesheet_dimensions(&oversized)
            .unwrap_err()
            .starts_with("PET_ASSET_DIMENSIONS_INVALID:"));
    }

    #[test]
    fn extraction_accepts_wrapper_and_validates_manifest_asset() {
        let manifest = br#"{"id":"wrapped_pet","displayName":"Wrapped","spritesheetPath":"art/spritesheet.webp"}"#;
        let webp = valid_test_webp();
        let archive = build_archive(&[
            ("wrapper/pet.json", manifest),
            ("wrapper/art/spritesheet.webp", &webp),
        ]);
        let directory = TestDirectory::new("valid-wrapper");
        let parsed = extract_pet_archive(&archive, &directory.0).unwrap();
        assert_eq!(parsed.id, "wrapped_pet");
        assert_eq!(fs::read(directory.0.join("pet.json")).unwrap(), manifest);
        assert_eq!(
            fs::read(directory.0.join("art/spritesheet.webp")).unwrap(),
            webp
        );
        assert!(!directory.0.join("wrapper").exists());
    }

    #[test]
    fn extraction_rejects_traversal_before_creating_staging() {
        let archive = build_archive(&[
            (
                "pet.json",
                br#"{"id":"safe_pet","spritesheetPath":"spritesheet.webp"}"#,
            ),
            ("../escape", b"bad"),
            ("spritesheet.webp", b"RIFF\x04\x00\x00\x00WEBP"),
        ]);
        let directory = TestDirectory::new("traversal");
        let error = extract_pet_archive(&archive, &directory.0).unwrap_err();
        assert!(error.starts_with("PET_PATH_INVALID:"));
        assert!(!directory.0.exists(), "完整校验失败前不得创建 staging");
    }
}
