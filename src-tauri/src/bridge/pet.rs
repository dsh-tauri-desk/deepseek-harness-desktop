//! bridge/pet.rs — 桌宠（外置透明宠物窗口）的 Tauri 命令出口。
//!
//! 这些命令被 dsh 容器（iframe 内的 dsh 界面 / dsh-tauri-pet 插件）经 invoke
//! 桥调用（壳层桥监听模块 `src/hooks/use-invoke-iframe.ts` 把 iframe 的
//! postMessage invoke 转发到 `@tauri-apps/api/core` 的 `invoke`）。所有状态
//! 读写统一落在 `config::setting`（持久化）与 `desktop::pet`（窗口）。
//! 错误遵循仓库约定：`Result<_, String>`，Err 以大写协议前缀开头（如
//! `PET_SIZE_OUT_OF_RANGE:`）。
//!
//! 实时性：一切会改变设置状态（开关/选择/大小）的命令都通过 `pet://status`
//! 事件把最新设置推给 pet 窗口；会话 CRUD 则通过独立的 `session:*` 事件直接转发。

use crate::config;
use crate::desktop::pet as pet_window;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use zip::ZipArchive;

/// 宠物大小百分比合法区间（精灵图缩放 50%–200%，与插件设置页滑条一致）。
pub const PET_SIZE_MIN: f64 = pet_window::PET_SIZE_MIN_PERCENT;
pub const PET_SIZE_MAX: f64 = pet_window::PET_SIZE_MAX_PERCENT;

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

/// 设置变化推送给 pet 窗口的事件名；会话生命周期使用 `session:*` 事件。
pub const PET_STATUS_EVENT: &str = "pet://status";

/// 桌宠当前完整状态（设置页、插件与 pet 窗口读取）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetStatus {
    /// 桌宠是否启用（持久化）。关闭宠物即写 false，重启后保持关闭。
    pub enabled: bool,
    /// 桌宠窗口当前是否应显示。
    ///
    /// 恒等于 `enabled`：窗口的可见性现在完全由持久开关决定 —— 从前的「临时收起」
    /// （进程内瞬态、重启即恢复）已移除，用户主动关闭就是关闭。字段保留是为了
    /// 桥接契约稳定（侧栏绿点、pet 窗口渲染都读它）。
    pub visible: bool,
    /// 当前桌宠 id；持久值缺省或空白时返回空串（未选择任何宠物）。
    pub active_pet: String,
    /// 宠物大小百分比（50–200，100 = 精灵图原始尺寸）；None = 未设置（默认 100）。
    pub pet_size: Option<f64>,
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

/// 将缺省、旧版未限定 id 或非法选择归一化为空字符串（未选择任何宠物）。
/// 合法值：预设宠物 id（`resources/preset-pets.json` 的安全字符集）或来源限定 id。
/// 注意：不再默认给内置宠物 —— 全新安装下 active_pet 为空，由用户在设置页主动启用
/// （预设条目直连远端素材，启用即用，无需任何安装步骤）。
fn normalize_active_pet(active_pet: Option<&str>) -> String {
    let Some(id) = active_pet.map(str::trim).filter(|id| !id.is_empty()) else {
        return String::new();
    };
    if crate::bridge::preset_pet::safe_preset_id(id) || parse_qualified_id(id).is_ok() {
        id.to_string()
    } else {
        String::new()
    }
}

/// 由持久设置推导唯一的对外状态（窗口可见性 = 持久开关，没有额外的进程内状态）。
fn status_from_setting(setting: &config::Setting) -> PetStatus {
    PetStatus {
        enabled: setting.pet_enabled,
        visible: setting.pet_enabled,
        active_pet: normalize_active_pet(setting.active_pet.as_deref()),
        pet_size: setting.pet_size,
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

/// 启用/关闭桌宠（持久化）。侧栏入口、设置页与桌宠窗口自身的关闭请求都走这里。
///
/// 关闭即销毁窗口实例（不是 hide，见 `desktop::pet::set_pet_window_visible`：隐藏窗口里
/// 的 `<video>` 仍会播放并持有 Video Wake Lock，issue #469），因此必须走
/// [`defer_pet_window_op`] 在非主线程执行。
///
/// **持久化是刻意的**：`enabled=false` 落盘后重启不再自动拉起桌宠。从前「收起」只改
/// 进程内瞬态，导致用户明明关了宠物、重启又自己出来。
#[tauri::command]
pub fn set_pet_enabled(app: AppHandle, enabled: bool) -> Result<PetStatus, String> {
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.pet_enabled = enabled;
    });
    // 关闭即无消费者：先停掉宿主会话流订阅，窗口销毁随后在后台完成。
    sync_pet_session_stream(&app, enabled);
    defer_pet_window_op(&app, enabled)?;
    let status = status_from_setting(&updated);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 选择桌宠模型包并持久化 active_pet。
///
/// 空串表示清除选择（存 `None`，与全新安装一致）：设置页已选卡片可再次点击取消，
/// 而不是一旦选中就无法撤销。清空后桌宠窗口无内容可渲染，调用方应同时关闭窗口。
#[tauri::command]
pub fn set_active_pet(app: AppHandle, id: String) -> Result<PetStatus, String> {
    let cleared = normalize_set_active_pet_id(&id)?;
    let updated = config::update_store_dat_setting(&app, |setting| {
        setting.active_pet = cleared;
    });
    let status = status_from_setting(&updated);
    emit_pet_status(&app, &status);
    Ok(status)
}

/// 选择 id 归一化：空串（去除首尾空白后）表示清除选择；非空沿用既有合法性校验
///（预设安全字符集或来源限定 id），非法 id 保持报错而不静默清空。
fn normalize_set_active_pet_id(id: &str) -> Result<Option<String>, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    validate_active_pet_id(trimmed)?;
    Ok(Some(trimmed.to_string()))
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

/// 将 DSH 会话原始数据推送到独立桌宠 WebView，不在桌面端构造宠物专用结构。
#[tauri::command]
pub fn push_pet_session(app: AppHandle, action: String, session: Value) -> Result<(), String> {
    let action = action.trim();
    if !matches!(action, "create" | "update" | "remove") {
        return Err("PET_SESSION_ACTION_INVALID: action must be create/update/remove".to_string());
    }
    let id = session
        .get("id")
        .or_else(|| session.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "PET_SESSION_ID_INVALID: raw session must include id".to_string())?;
    let event = match action {
        "create" => "session:create",
        "update" => "session:update",
        "remove" => "session:remove",
        _ => unreachable!("session action was validated above"),
    };
    app.emit_to(pet_window::PET_WINDOW_LABEL, event, session)
        .map_err(|error| format!("PET_SESSION_PUSH_FAILED: failed to emit session {id}: {error}"))
}

/// DSH 宿主会话增量 SSE 流路径（与 packages/dsh-tauri-pet/src/index.ts 的
/// SESSION_STREAM_PATH 保持一致）。
const SESSION_STREAM_PATH: &str = "/api/dsh-pet/session-stream";

/// 会话增量「动作 → 桌宠窗口事件名」映射（与 push_pet_session 共用）。
fn session_event_of(action: &str) -> Option<&'static str> {
    match action {
        "create" => Some("session:create"),
        "update" => Some("session:update"),
        "remove" => Some("session:remove"),
        _ => None,
    }
}

/// 直接把「动作 + 展示载荷」推给桌宠窗口（返回是否成功，仅用于 debug 日志）。
fn emit_pet_session(app: &AppHandle, action: &str, payload: &Value) {
    let Some(event) = session_event_of(action) else {
        return;
    };
    let _ = app.emit_to(pet_window::PET_WINDOW_LABEL, event, payload.clone());
}

/// 消费宿主会话增量 SSE 流：读取 `http://127.0.0.1:<port>/api/dsh-pet/session-stream`，
/// 每个 `data:` 帧（`{"action":...,"payload":...}`）解析后经 emit_to 直达桌宠 WebView。
///
/// 方案 1（host → rust → pet）：Rust 不再依赖 iframe 的 invoke 桥转发（#396 根因），
/// 而是作为宿主流的消费者。流中断（宿主未就绪/重启）时退避重连，幂等可恢复。
async fn consume_pet_session_stream(app: &AppHandle, url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    // SSE: data: 行累积，遇空行派发一帧；': keepalive' 注释帧忽略。
    let mut pending_data: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        buffer.extend_from_slice(&chunk);
        while let Some(position) = buffer.iter().position(|&byte| byte == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=position).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned();
            let trimmed = line.trim();
            if let Some(data) = trimmed.strip_prefix("data:") {
                pending_data.push(data.trim().to_string());
            } else if trimmed.is_empty() {
                if !pending_data.is_empty() {
                    let frame: Value = serde_json::from_str(&pending_data.join("\n"))
                        .map_err(|error| error.to_string())?;
                    let action = frame
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                    emit_pet_session(app, &action, &payload);
                    pending_data.clear();
                }
            }
            // 其余（'：' 开头的注释帧等）忽略。
        }
    }
    Ok(())
}

/// 会话增量流消费任务的句柄：桌宠停用/隐藏时 abort，宿主侧 SSE 客户端随连接
/// 关闭归零（宿主插件据此注销 `session/event` 监听）。
fn pet_stream_handle() -> &'static Mutex<Option<tauri::async_runtime::JoinHandle<()>>> {
    static HANDLE: OnceLock<Mutex<Option<tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

/// 是否需要订阅宿主会话增量流：桌宠已启用（窗口存在）。
///
/// 关闭桌宠（`set_pet_enabled(false)`）会销毁窗口，同样视为无消费者——窗口不渲染时
/// 转发毫无意义，停掉订阅即让宿主的热路径与逐会话累计态一并短路。
pub fn pet_stream_wanted(app: &AppHandle) -> bool {
    let status = status_from_setting(&config::get_store_dat_setting(app));
    status.enabled && status.visible
}

/// 断线重连日志的重记间隔：状态持续不变时最多这么久重记一次。
///
/// 宿主未就绪（启动中，或插件操作期间被主动停止）时这条流会每 2s 失败一次，
/// 逐次输出会在几秒内刷满日志、把真正的错误挤掉。
const PET_STREAM_RELOG_INTERVAL: Duration = Duration::from_secs(60);

/// 「会话流正常结束」在日志节流里的状态名（宿主重启时属正常，不需要告警）。
const PET_STREAM_ENDED: &str = "stream ended";

/// 重连日志节流器：只在「状态首次出现 / 状态变化 / 距上次输出已超过
/// [`PET_STREAM_RELOG_INTERVAL`]」时允许输出，其余相同的重复失败降级为 debug。
///
/// 状态用失败原因字符串表示：宿主不可用期间原因通常是稳定的一条（如
/// `HTTP 502 Bad Gateway`），于是整段不可用期被压成首行 + 每分钟一行；原因变化
/// （换了一种坏法）则立即重新输出，不会把新问题一起静默掉。
struct PetStreamLogThrottle {
    last_state: Option<String>,
    last_logged: Instant,
    relog_interval: Duration,
}

impl PetStreamLogThrottle {
    fn new() -> Self {
        Self {
            last_state: None,
            last_logged: Instant::now(),
            relog_interval: PET_STREAM_RELOG_INTERVAL,
        }
    }

    /// 记录一次状态，返回这一行是否应当输出。
    fn should_log(&mut self, state: &str) -> bool {
        let repeated = self.last_state.as_deref() == Some(state);
        self.last_state = Some(state.to_string());
        if repeated && self.last_logged.elapsed() < self.relog_interval {
            return false;
        }
        self.last_logged = Instant::now();
        true
    }
}

/// 按「是否有消费者」启停「宿主会话增量 SSE」消费任务（见
/// [`consume_pet_session_stream`]），幂等：启用且无活动任务才 spawn；停用时
/// abort 任务，连接立即关闭。
///
/// 调用点：应用 setup、`set_pet_enabled`。桌宠关闭后 Rust 不再是宿主流的消费者，
/// 宿主侧随即不再为桌宠做任何转发。
pub fn sync_pet_session_stream(app: &AppHandle, wanted: bool) {
    let slot = pet_stream_handle();
    let mut handle = slot.lock().unwrap_or_else(|error| error.into_inner());
    if !wanted {
        if let Some(task) = handle.take() {
            task.abort();
            log::info!("[pet-stream] host session stream stopped (pet disabled or hidden)");
        }
        return;
    }
    if handle
        .as_ref()
        .is_some_and(|task| !task.inner().is_finished())
    {
        return;
    }
    let app = app.clone();
    *handle = Some(tauri::async_runtime::spawn(async move {
        // 重连是 2s 一次的常态循环，宿主未就绪时会连续失败几十上百次：逐次输出
        // 会刷满日志并挤掉真正的错误，因此按状态节流（见 [`PetStreamLogThrottle`]）。
        let mut throttle = PetStreamLogThrottle::new();
        loop {
            let setting = config::get_store_dat_setting(&app);
            let url = format!("http://127.0.0.1:{}{}", setting.port, SESSION_STREAM_PATH);
            match consume_pet_session_stream(&app, &url).await {
                Ok(()) => {
                    if throttle.should_log(PET_STREAM_ENDED) {
                        log::info!("[pet-stream] host session stream ended; reconnecting in 2s");
                    } else {
                        log::debug!("[pet-stream] host session stream ended (repeated)");
                    }
                }
                Err(error) => {
                    if throttle.should_log(&error) {
                        log::warn!(
                            "[pet-stream] host session stream error: {error}; reconnecting in 2s"
                        );
                    } else {
                        log::debug!("[pet-stream] host session stream error (suppressed): {error}");
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }));
}

/// 按物理像素增量移动桌宠窗口，限制在可见显示器并保存最终位置。
///
/// 缩放（`pet://status` 收到新 pet_size）后由 pet WebView 调用 `move_pet_window(0, 0)`
/// 把放大后的窗口夹回可见屏幕，避免右侧/底部被推出屏幕。
#[tauri::command]
pub fn move_pet_window(app: AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    pet_window::move_pet_window(&app, delta_x, delta_y)
}

/// 串行化桌宠窗口的可见性操作，保证「关闭 → 再启用」按调用顺序执行。
fn pet_window_op_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 把窗口可见性操作丢到异步运行时执行（创建窗口与销毁窗口都**不允许**在主线程调用）。
///
/// # 为什么必须离开主线程
///
/// Tauri 的 command handler 在主线程执行，而 `tauri-runtime-wry` 对主线程上的窗口
/// 生命周期消息是**直接 panic**：
///
/// - `WindowMessage::Destroy`：`panic!("cannot handle \`WindowMessage::Destroy\` on the
///   main thread")`（tauri-runtime-wry 2.11.4 lib.rs:3494）；调用点在 `send_user_message`
///   判定「当前线程 == 主线程」后**同步**派发，因此主线程调 `destroy()` 必崩。
/// - `create_window`：经 channel 等主线程事件循环回包，主线程调用必然死锁
///   （同文件 lib.rs:2757 注释）。
///
/// 之前的 `hide()` 之所以看起来能用，只是因为 `WindowMessage::Hide` 走了不 panic 的分支；
/// 换成销毁后就踩中了这条主线程断言（实测表现为：关闭宠物后 `get_pet_status` 等
/// 全部 invoke 超时、主 webview 一起卡住）。
fn defer_pet_window_op(app: &AppHandle, visible: bool) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 串行锁：并发/快速连点的关闭与启用不会交错，最终态等于最后一次调用。
        let _guard = pet_window_op_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Err(error) = pet_window::set_pet_window_visible(&app, visible) {
            log::error!("PET_WINDOW_VISIBILITY_FAILED: visible={visible}: {error}");
            let status = status_from_setting(&config::get_store_dat_setting(&app));
            emit_pet_status(&app, &status);
        }
    });
    Ok(())
}

/// pet 窗口点击穿透开关；返回实际生效的穿透态，前端据此对齐本地 optimistic 状态。
///
/// # 为什么不直接用 `setIgnoreCursorEvents`（issue #437）
///
/// Linux 下 tao 处理 `CursorIgnoreEvents(true)` 时对 GtkWindow 的底层 GdkWindow
/// 直接 `unwrap()`（tao 0.35.3 event_loop.rs:457，截至 0.37.0 上游仍未修复），
/// 窗口从未显示（未 realize，GdkWindow 不存在）即 panic；panic 发生在 GTK
/// 事件循环回调里无法回卷 → SIGABRT，整个桌面端崩溃。而本应用在 setup 阶段
/// 总会预创建隐藏的 pet 窗口（`desktop::pet::init_pet_window`，全新安装默认
/// 不启用桌宠则永远不 show），其 webview 仍会加载 pet.html 并在收到首个全局
/// 鼠标事件时请求穿透——这正是 v0.11.0 初始化阶段必崩的路径。
///
/// 因此所有穿透切换必须经由此命令：窗口不可见（GTK 未 map，必然未 realize）
/// 时吞掉 `true` 请求并返回未生效；`false`（恢复接收事件）在 tao 走无 unwrap
/// 的分支，始终安全转发。GTK 窗口 hide 只 unmap 不 unrealize，首次 show 之后
/// GdkWindow 持续存在，故「可见 ⇒ 转发安全」。
#[tauri::command]
pub fn set_pet_ignore_cursor_events(window: WebviewWindow, ignore: bool) -> Result<bool, String> {
    if window.label() != pet_window::PET_WINDOW_LABEL {
        return Err(
            "PET_WINDOW_LABEL_MISMATCH: this command is restricted to the pet window".to_string(),
        );
    }
    if ignore {
        let visible = window
            .is_visible()
            .map_err(|error| format!("PET_WINDOW_STATE_FAILED: {error}"))?;
        if !visible {
            // 隐藏窗口的穿透无意义：吞掉并上报「未生效」，避免 tao 在未
            // realize 窗口上的 unwrap panic（issue #437）。
            return Ok(false);
        }
    }
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| format!("PET_CURSOR_IGNORE_FAILED: {error}"))?;
    Ok(ignore)
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

/// 校验激活宠物 id：预设宠物（安全字符集）或来源限定 id。
fn validate_active_pet_id(id: &str) -> Result<(), String> {
    if crate::bridge::preset_pet::safe_preset_id(id) {
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

    // ---- 重连日志节流（宿主不可用期间每 2s 一次失败不能刷满日志）----

    fn throttle(relog_interval: Duration) -> PetStreamLogThrottle {
        PetStreamLogThrottle {
            last_state: None,
            last_logged: Instant::now(),
            relog_interval,
        }
    }

    #[test]
    fn pet_stream_throttle_suppresses_identical_failures() {
        // 宿主不可用期间同一条 502 每次重连都复现：只留第一行，其余静默
        let mut throttle = throttle(Duration::from_secs(60));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(!throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(!throttle.should_log("HTTP 502 Bad Gateway"));

        // 换成另一种坏法 → 立即重新输出，不会被前一种的静默期吞掉
        assert!(throttle.should_log("error decoding response body"));
        // 回到前一种原因同样算状态变化
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
    }

    #[test]
    fn pet_stream_throttle_relogs_after_interval() {
        // 长时间不可用仍需留痕：到期后重记一次，而不是整段彻底静默
        let mut throttle = throttle(Duration::ZERO);
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
    }

    #[test]
    fn pet_stream_throttle_keeps_ended_and_error_distinct() {
        // 「正常结束」（宿主重启）与失败是两种状态，不会互相静默掉
        let mut throttle = throttle(Duration::from_secs(60));
        assert!(throttle.should_log(PET_STREAM_ENDED));
        assert!(!throttle.should_log(PET_STREAM_ENDED));
        assert!(throttle.should_log("HTTP 502 Bad Gateway"));
        assert!(throttle.should_log(PET_STREAM_ENDED));
    }

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
    fn active_pet_defaults_to_empty_when_unset_or_invalid() {
        // 全新安装不再默认选中内置宠物：缺省/空白/非法 id 一律归一为空串（未选择）。
        assert_eq!(normalize_active_pet(None), "");
        assert_eq!(normalize_active_pet(Some("   ")), "");
        assert_eq!(
            normalize_active_pet(Some(" chat:custom-pet ")),
            "chat:custom-pet",
            "有效 id 应只去除首尾空白"
        );
        assert_eq!(
            normalize_active_pet(Some("codex:custom_pet")),
            "codex:custom_pet"
        );
        // 未限定 id（预设宠物，安全字符集）与来源限定 id 都是合法激活选择；
        // 只有非法字符集 / 未知来源限定才归一为空串（未选择任何宠物）。
        assert_eq!(normalize_active_pet(Some("cat")), "cat");
        assert_eq!(normalize_active_pet(Some("shiba")), "shiba");
        for legacy_or_invalid in ["other:pet", "chat:../pet", "bad id", "x/y"] {
            assert_eq!(
                normalize_active_pet(Some(legacy_or_invalid)),
                "",
                "旧版或非法 id {legacy_or_invalid} 应归一为空串（未选择宠物）"
            );
        }
    }

    #[test]
    fn set_active_pet_accepts_empty_as_clear() {
        // 空串/纯空白表示清除选择：存 None（与全新安装一致），而不是非法 id 报错。
        assert_eq!(normalize_set_active_pet_id(""), Ok(None));
        assert_eq!(normalize_set_active_pet_id("   "), Ok(None));
        // 非空保持既有校验：合法 id 原样存（去空白），非法 id 仍然报错。
        assert_eq!(
            normalize_set_active_pet_id("  maid-deepseek-whale  "),
            Ok(Some("maid-deepseek-whale".to_string()))
        );
        assert_eq!(
            normalize_set_active_pet_id("chat:custom-pet"),
            Ok(Some("chat:custom-pet".to_string()))
        );
        assert!(
            normalize_set_active_pet_id("bad id").is_err(),
            "非法 id 不应被静默当作清除"
        );
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
        assert_eq!(status.active_pet, "");
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
