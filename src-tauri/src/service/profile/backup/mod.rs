//! 档案备份（ZIP）：列出、创建、还原、读取/保存设置与自动备份调度。
//!
//! 备份为本机压缩 ZIP，保存在 `$DSH_HOME/backups/profiles/<profile-id>/`，
//! 命名 `<创建时间ms>-<原因>.zip`，内部含 `backup.json`（版本 / Profile ID /
//! 时间 / 原因 / 配置指纹）与 `profile/` 配置内容（见 [`zip`]）。
//!
//! 自动备份规则（由 scheduler 周期调用 [`check_auto`]）：
//! - 每次桌面端启动最多触发一次启动备份（Harness 因切换、插件或修复而重启
//!   不重复触发；桌面端完全退出后不运行，下次启动补查到期或关闭期间的变更）
//! - 运行中每分钟检查配置变化（排除依赖目录后的内容指纹比对 + 10 秒稳定防抖；
//!   首次启用且没有历史备份时先创建基线 ZIP）
//! - 每小时检查周期是否到期（以该档案最近任意备份时间计算）
//! - 同一轮若启动备份已创建，则不再创建重复的变化或周期备份
//! - 每次成功创建 ZIP 后按档案删除最旧备份（`max_count`）；失败时绝不清理
//! - 自动备份成功和失败均调用原生通知（含档案名与触发原因）；通知失败只记日志，
//!   scheduler 的例行检查本身不通知
//!
//! 还原：先为当前状态创建 `before_restore` 保护备份（当前运行档案先停止
//! Harness），再解压到临时目录并校验（Profile ID / 格式 / Hash / 安全相对路径）
//! 通过后才替换目录，并写入依赖重建标记（下次启动执行 `pnpm install`）。

mod zip;

use crate::config::{self, ProfileBackupSettings};
use crate::service::fs_guard;
use crate::service::profile::{active_profile, profile_dir_of, display_name, Profile};
use crate::service::workflow;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

/// 备份根目录（`$DSH_HOME/backups/profiles`）
fn backups_root(app_handle: &AppHandle) -> PathBuf {
    config::get_dsh_data_path(app_handle).join("backups").join("profiles")
}

/// 读取 `$DSH_HOME/.credentials.yaml` 的内容（文件不存在或不可读返回 None——
/// 凭据缺失不阻塞备份，压缩包只是不含凭据条目）。
fn credentials_file(app_handle: &AppHandle) -> Option<Vec<u8>> {
    let path = config::get_dsh_data_path(app_handle).join(CREDENTIALS_FILE_NAME);
    if path.is_file() {
        fs::read(&path).ok()
    } else {
        None
    }
}

/// 前端监听的事件名（每次成功创建 ZIP 后推送，历史列表据此刷新）
pub(crate) const BACKUPS_UPDATED_EVENT: &str = "profile-backups-updated";

/// 配置变化检查间隔（scheduler 按此频率做指纹比对）
const AUTO_CHANGE_INTERVAL: Duration = Duration::from_secs(60);
/// 周期到期检查间隔（不必每分钟扫描备份目录）
const AUTO_INTERVAL_CHECK_INTERVAL: Duration = Duration::from_secs(3600);
/// 配置变化归档前的稳定窗口（连续写盘期间不归档）
const CONFIG_CHANGE_DEBOUNCE: Duration = Duration::from_secs(10);
/// 自动跟踪状态文件名（位于备份目录内，列表只认 `*.zip`）
const STATE_FILE: &str = ".state.json";

/// 备份触发原因（固定五种，序列化为 snake_case 字符串）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupReason {
    Manual,
    Startup,
    Interval,
    ConfigChange,
    BeforeRestore,
}

/// 凭据文件名（`$DSH_HOME` 根目录）：`include_credentials` 时纳入 ZIP
/// （根级 `credentials.yaml` 条目），还原时写回该路径。
const CREDENTIALS_FILE_NAME: &str = ".credentials.yaml";

impl BackupReason {
    /// 全部原因（还原校验 backup_id 用：文件名段只允许这五种）
    pub const ALL: [BackupReason; 5] = [
        BackupReason::Manual,
        BackupReason::Startup,
        BackupReason::Interval,
        BackupReason::ConfigChange,
        BackupReason::BeforeRestore,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BackupReason::Manual => "manual",
            BackupReason::Startup => "startup",
            BackupReason::Interval => "interval",
            BackupReason::ConfigChange => "config_change",
            BackupReason::BeforeRestore => "before_restore",
        }
    }

    /// 原生通知里的原因文案键（Rust 侧 i18n）
    fn i18n_key(self) -> &'static str {
        match self {
            BackupReason::Manual => "backup.reason.manual",
            BackupReason::Startup => "backup.reason.startup",
            BackupReason::Interval => "backup.reason.interval",
            BackupReason::ConfigChange => "backup.reason.config_change",
            BackupReason::BeforeRestore => "backup.reason.before_restore",
        }
    }
}

/// 备份行（序列化 camelCase 给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBackup {
    /// 备份 id（`<创建时间ms>-<原因>`，即文件名去 `.zip`）
    pub id: String,
    pub profile_id: String,
    /// 创建时间（毫秒时间戳）
    pub created_at: i64,
    /// 触发原因（`BackupReason` 的 snake_case 字符串）
    pub reason: String,
    /// 压缩包字节数
    pub size_bytes: u64,
}

/// 还原结果：还原后的档案 + 是否停止了 Harness（前端据此调用既有重启流程）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub profile: Profile,
    pub service_stopped: bool,
}

/// 自动备份跟踪状态（持久化在备份目录的 `.state.json`，跨桌面会话生效：
/// 下次启动补查关闭期间的配置变更）
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoState {
    last_fingerprint: Option<String>,
    pending_fingerprint: Option<String>,
    pending_since_ms: Option<u64>,
}

/// 自动备份调度门（进程内状态：启动备份每桌面会话至多一次，检查按分钟/小时节流）
struct AutoGate {
    startup_done: bool,
    last_change_check: Option<Instant>,
    last_interval_check: Option<Instant>,
}

fn auto_gate() -> &'static Mutex<AutoGate> {
    static GATE: OnceLock<Mutex<AutoGate>> = OnceLock::new();
    GATE.get_or_init(|| {
        Mutex::new(AutoGate {
            startup_done: false,
            last_change_check: None,
            last_interval_check: None,
        })
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 解析备份 id（`<毫秒>-<原因>`）：非法形态返回 `(None, 原样)`。
fn parse_backup_id(file_stem: &str) -> (Option<i64>, String) {
    match file_stem.split_once('-') {
        Some((ms, reason)) => (ms.parse().ok(), reason.to_string()),
        None => (None, file_stem.to_string()),
    }
}

/// 读取自动跟踪状态（文件缺失/损坏回落默认）。
fn load_state(dir: &Path) -> AutoState {
    fs::read_to_string(dir.join(STATE_FILE))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

/// 写入自动跟踪状态（先写临时文件再改名，避免半成品）。
fn save_state(dir: &Path, state: &AutoState) {
    let Ok(content) = serde_json::to_string_pretty(state) else {
        return;
    };
    let tmp = dir.join(format!(".state-{}.tmp", std::process::id()));
    if fs::write(&tmp, content).is_ok() {
        let _ = fs::rename(&tmp, dir.join(STATE_FILE));
    }
}

/// 列出备份目录内的 ZIP（按创建时间升序；目录不存在返回空）。
fn list_in_dir(dir: &Path) -> Result<Vec<ProfileBackup>, String> {
    let profile_id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("BACKUP_LIST_FAILED: {e}"))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("zip") {
            continue;
        }
        let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let (created_at, reason) = parse_backup_id(file_stem);
        let Some(created_at) = created_at else {
            continue;
        };
        // 只展示已知原因：手工放置的假 ZIP 不应在前端渲染出缺失的 i18n 键
        if !BackupReason::ALL.iter().any(|r| r.as_str() == reason) {
            continue;
        }
        out.push(ProfileBackup {
            id: file_stem.to_string(),
            profile_id: profile_id.clone(),
            created_at,
            reason,
            size_bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by_key(|backup| backup.created_at);
    Ok(out)
}

/// 成功创建 ZIP 后按档案删除最旧备份（`max_count` 内保留；失败绝不调用）。
fn prune(dir: &Path, max_count: u32) {
    let Ok(backups) = list_in_dir(dir) else {
        return;
    };
    let keep = max_count as usize;
    if backups.len() <= keep {
        return;
    }
    for backup in backups.iter().take(backups.len() - keep) {
        let path = dir.join(format!("{}.zip", backup.id));
        if let Err(e) = fs::remove_file(&path) {
            log::warn!("failed to prune old backup {}: {e}", path.display());
        } else {
            log::info!("pruned old backup {}", path.display());
        }
    }
}

/// 创建一份 ZIP 备份（核心路径：手动 / 自动 / 还原前保护备份共用）。
///
/// `include_credentials` 为 true 时把 `$DSH_HOME/.credentials.yaml` 纳入压缩包
/// （ZIP 根级 `credentials.yaml` 条目，参与指纹哈希）。凭据文件不存在或不可读
/// 时静默跳过（不视为失败）。
///
/// 成功后按当前设置的 `max_count` 清理该档案最旧备份，并向历史列表推送事件。
fn create_zip_backup(
    app_handle: &AppHandle,
    profile_id: &str,
    reason: BackupReason,
    include_credentials: bool,
) -> Result<ProfileBackup, String> {
    let profile_dir = profile_dir_of(app_handle, profile_id);
    if !profile_dir.is_dir() {
        return Err(format!("PROFILE_NOT_FOUND: profile {profile_id} does not exist"));
    }
    let dir = fs_guard::join_safe(&backups_root(app_handle), profile_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("BACKUP_MKDIR_FAILED: {e}"))?;

    // 凭据只随手动备份的显式开关进入压缩包；自动备份永远不带（见 create_auto）
    let credentials = if include_credentials {
        credentials_file(app_handle)
    } else {
        None
    };
    let config_hash = zip::fingerprint_with_credentials(&profile_dir, credentials.as_deref())
        .ok_or_else(|| format!("BACKUP_FINGERPRINT_FAILED: cannot scan profile {profile_id}"))?;
    let created_at = now_ms();
    let id = format!("{created_at}-{}", reason.as_str());
    let dest = dir.join(format!("{id}.zip"));
    let meta = zip::BackupMeta {
        format_version: zip::FORMAT_VERSION,
        profile_id: profile_id.to_string(),
        created_at,
        reason: reason.as_str().to_string(),
        config_hash,
    };
    zip::create_zip(&profile_dir, &dest, &meta, credentials.as_deref())?;

    // 只在成功路径清理：失败时绝不删除已有备份
    let settings = get_settings(app_handle);
    prune(&dir, settings.max_count);

    let backup = ProfileBackup {
        id,
        profile_id: profile_id.to_string(),
        created_at,
        reason: reason.as_str().to_string(),
        size_bytes: fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
    };
    let _ = app_handle.emit(BACKUPS_UPDATED_EVENT, &backup);
    Ok(backup)
}

/// 自动备份（startup / interval / config_change）：按设置决定是否发送原生
/// 通知（默认关闭，本功能面向配置面板的高级用户，后台例行行为不打扰）；
/// 返回是否实际创建了 ZIP（供同一轮去重）。
///
/// 自动备份永远不带凭据：密钥不应在用户不知情时被周期性地复制进备份文件。
fn create_auto(app_handle: &AppHandle, reason: BackupReason) -> bool {
    let profile_id = active_profile(app_handle);
    // 通知开关在创建前读取一次；创建本身不改变设置
    let notify = get_settings(app_handle).notify;
    match create_zip_backup(app_handle, &profile_id, reason, false) {
        Ok(backup) => {
            log::info!(
                "auto backup created for profile {profile_id}: {} ({} bytes)",
                backup.id,
                backup.size_bytes
            );
            if notify {
                notify_backup(app_handle, &profile_id, reason, true);
            }
            true
        }
        Err(e) => {
            log::error!("auto backup failed for profile {profile_id}: {e}");
            if notify {
                notify_backup(app_handle, &profile_id, reason, false);
            }
            false
        }
    }
}

/// 原生通知：自动备份成功/失败（含档案名与触发原因）。通知失败只记日志。
fn notify_backup(app_handle: &AppHandle, profile_id: &str, reason: BackupReason, ok: bool) {
    let name = display_name(app_handle, profile_id);
    let title = config::i18n::t(if ok {
        "backup.notify_success_title"
    } else {
        "backup.notify_failed_title"
    });
    let reason_label = config::i18n::t(reason.i18n_key());
    let body = if ok {
        config::i18n::fill_template(
            &config::i18n::t("backup.notify_success_body"),
            &[&name, &reason_label],
        )
    } else {
        config::i18n::fill_template(
            &config::i18n::t("backup.notify_failed_body"),
            &[&name, &reason_label],
        )
    };
    if let Err(e) = app_handle.notification().builder().title(&title).body(&body).show() {
        log::warn!("backup notification failed: {e}");
    }
}

/// 周期备份是否到期的纯计算：最近任意备份早于 `interval_days` 天前即到期；
/// 从未备份视为到期。
fn interval_due_ms(last_created_at: Option<i64>, now_ms: i64, interval_days: u32) -> bool {
    match last_created_at {
        None => true,
        Some(last) => now_ms.saturating_sub(last) >= i64::from(interval_days) * 86_400_000,
    }
}

/// 周期备份是否到期：以该档案最近任意备份时间计算。
fn interval_due(app_handle: &AppHandle, interval_days: u32) -> bool {
    let profile_id = active_profile(app_handle);
    let Ok(dir) = fs_guard::join_safe(&backups_root(app_handle), &profile_id) else {
        return false;
    };
    let last = list_in_dir(&dir).ok().and_then(|backups| backups.last().map(|b| b.created_at));
    interval_due_ms(last, now_ms(), interval_days)
}

/// 配置变化是否应归档的纯决策（供 [`check_config_change`] 与单测使用）：
///
/// - 指纹与 `last` 相同 → 无变化，不归档
/// - 尚无 `last`（首次跟踪）→ 不归档（基线由调用方按「无历史备份」决定）
/// - 指纹变化但 `pending` 尚未记录/不是当前指纹 → 防抖刚开始，不归档
/// - `pending` 与当前指纹一致且已稳定 ≥ `CONFIG_CHANGE_DEBOUNCE` → 归档
fn change_should_archive(
    last: Option<&str>,
    pending: Option<&str>,
    pending_since_ms: Option<u64>,
    fp: &str,
    now_ms: u64,
) -> bool {
    if last == Some(fp) || last.is_none() || pending != Some(fp) {
        return false;
    }
    pending_since_ms
        .map(|since| now_ms.saturating_sub(since) >= CONFIG_CHANGE_DEBOUNCE.as_millis() as u64)
        .unwrap_or(false)
}

/// 配置变化检查：指纹比对 + 10 秒稳定防抖；首次启用且无历史备份时先建基线。
/// 返回是否创建了备份（供同一轮去重）。
fn check_config_change(app_handle: &AppHandle) -> bool {
    let profile_id = active_profile(app_handle);
    let profile_dir = profile_dir_of(app_handle, &profile_id);
    let Some(fp) = zip::fingerprint(&profile_dir) else {
        return false;
    };
    let Ok(dir) = fs_guard::join_safe(&backups_root(app_handle), &profile_id) else {
        return false;
    };
    let mut state = load_state(&dir);
    let now = now_ms().max(0) as u64;

    if state.last_fingerprint.as_deref() == Some(fp.as_str()) {
        // 无变化：清掉残留的 pending（内容回退场景）
        if state.pending_fingerprint.is_some() {
            state.pending_fingerprint = None;
            state.pending_since_ms = None;
            save_state(&dir, &state);
        }
        return false;
    }

    if state.last_fingerprint.is_none() {
        // 首次跟踪（首次启用或升级后首次运行）：没有历史备份时先创建基线 ZIP。
        // 只有成功创建才推进基线；失败保留 last=None，下次检查重试。
        let no_history = list_in_dir(&dir).map(|backups| backups.is_empty()).unwrap_or(true);
        let created = no_history && create_auto(app_handle, BackupReason::ConfigChange);
        if created {
            state.last_fingerprint = Some(fp);
        }
        save_state(&dir, &state);
        return created;
    }

    // 指纹变化：同值稳定 10 秒后才归档（连续写盘期间不打断）。
    // 只有成功归档才推进指纹；失败保留 pending，下次检查重试。
    if state.pending_fingerprint.as_deref() != Some(fp.as_str()) {
        state.pending_fingerprint = Some(fp.clone());
        state.pending_since_ms = Some(now);
        save_state(&dir, &state);
        return false;
    }
    if change_should_archive(
        state.last_fingerprint.as_deref(),
        state.pending_fingerprint.as_deref(),
        state.pending_since_ms,
        &fp,
        now,
    ) {
        let created = create_auto(app_handle, BackupReason::ConfigChange);
        if created {
            state.last_fingerprint = Some(fp);
            state.pending_fingerprint = None;
            state.pending_since_ms = None;
        }
        save_state(&dir, &state);
        return created;
    }
    false
}

/// 自动备份调度（scheduler 周期调用）：启动备份、配置变化、周期备份。
///
/// 例行检查本身不通知、不产生副作用；只有实际创建 ZIP 或失败时才通知。
pub fn check_auto(app_handle: &AppHandle) {
    let settings = get_settings(app_handle);
    if !settings.on_startup && !settings.on_change && settings.interval_days == 0 {
        return;
    }
    let mut gate = auto_gate().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let mut created = false;

    // 1) 启动备份：每个桌面会话至多一次
    if !gate.startup_done {
        gate.startup_done = true;
        if settings.on_startup {
            created = create_auto(app_handle, BackupReason::Startup);
        }
    }
    // 2) 配置变化：每分钟检查；同一轮已创建启动备份则跳过
    if !created
        && settings.on_change
        && gate
            .last_change_check
            .map_or(true, |last| last.elapsed() >= AUTO_CHANGE_INTERVAL)
    {
        gate.last_change_check = Some(now);
        created = check_config_change(app_handle);
    }
    // 3) 周期：每小时检查是否到期；同一轮已创建备份则跳过
    if !created
        && settings.interval_days > 0
        && gate
            .last_interval_check
            .map_or(true, |last| last.elapsed() >= AUTO_INTERVAL_CHECK_INTERVAL)
    {
        gate.last_interval_check = Some(now);
        if interval_due(app_handle, settings.interval_days) {
            let _ = create_auto(app_handle, BackupReason::Interval);
        }
    }
}

/// 列出档案备份（最新在前）。
pub fn list(app_handle: &AppHandle, profile_id: &str) -> Result<Vec<ProfileBackup>, String> {
    let dir = fs_guard::join_safe(&backups_root(app_handle), profile_id)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut backups = list_in_dir(&dir)?;
    backups.reverse();
    Ok(backups)
}

/// 手动创建档案备份。
///
/// 凭据包含与否遵循设置里的 `include_credentials` 开关（默认不带）。
pub fn create(app_handle: &AppHandle, profile_id: &str) -> Result<ProfileBackup, String> {
    fs_guard::validate_id(profile_id).map_err(|e| format!("BACKUP_INVALID_PROFILE: {e}"))?;
    let settings = get_settings(app_handle);
    create_zip_backup(
        app_handle,
        profile_id,
        BackupReason::Manual,
        settings.include_credentials,
    )
}

/// 读取档案自动备份设置。
pub fn get_settings(app_handle: &AppHandle) -> ProfileBackupSettings {
    config::get_store_dat_setting(app_handle).profile_backup
}

/// 删除一份备份 ZIP（历史列表的删除按钮）。
pub fn delete(app_handle: &AppHandle, profile_id: &str, backup_id: &str) -> Result<(), String> {
    fs_guard::validate_id(profile_id).map_err(|e| format!("BACKUP_INVALID_PROFILE: {e}"))?;
    // 与 restore 同一套 backup_id 校验：时间戳可解析且原因落在五种已知值内
    let (created_at, reason) = parse_backup_id(backup_id);
    if created_at.is_none() || !BackupReason::ALL.iter().any(|r| r.as_str() == reason) {
        return Err(format!("BACKUP_NOT_FOUND: invalid backup id {backup_id}"));
    }
    let dir = fs_guard::join_safe(&backups_root(app_handle), profile_id)?;
    let path = dir.join(format!("{backup_id}.zip"));
    if !path.is_file() {
        return Err(format!("BACKUP_NOT_FOUND: backup {backup_id} does not exist"));
    }
    fs::remove_file(&path).map_err(|e| format!("BACKUP_DELETE_FAILED: {e}"))?;
    log::info!("deleted profile backup {}", path.display());
    let _ = app_handle.emit(BACKUPS_UPDATED_EVENT, &serde_json::json!({ "profileId": profile_id }));
    Ok(())
}

/// 保存档案自动备份设置（数值字段钳制到合理范围）。
pub fn update_settings(
    app_handle: &AppHandle,
    settings: ProfileBackupSettings,
) -> Result<ProfileBackupSettings, String> {
    let normalized = ProfileBackupSettings {
        on_startup: settings.on_startup,
        on_change: settings.on_change,
        interval_days: settings.interval_days.min(3650),
        max_count: settings.max_count.clamp(1, 100),
        // 凭据开关是显式偏好，直接透传（无范围钳制）
        include_credentials: settings.include_credentials,
        // 通知开关是显式偏好，直接透传
        notify: settings.notify,
    };
    config::update_store_dat_setting(app_handle, |setting| {
        setting.profile_backup = normalized.clone();
    });
    Ok(normalized)
}

/// 还原档案备份。
///
/// 流程：校验备份存在 → 解压到临时目录并校验（Profile ID / 格式 / Hash /
/// 安全相对路径）→ 向解压结果写入依赖重建标记 → 当前运行档案停止 Harness →
/// 自动创建 `before_restore` 保护备份 → 交换目录（旧目录先挪到回收槽再换入，
/// 失败回滚，不留数据丢失窗口）→ 清理回收槽。
///
/// 停止 Harness 之后的任何失败都返回带 `SERVICE_STOPPED:` 前缀的错误，前端
/// 据此调用既有重启流程恢复服务（还原失败不能让桌面服务一直处于停止态）。
pub async fn restore(
    app_handle: &AppHandle,
    profile_id: &str,
    backup_id: &str,
) -> Result<RestoreResult, String> {
    fs_guard::validate_id(profile_id).map_err(|e| format!("BACKUP_INVALID_PROFILE: {e}"))?;
    // backup_id 必须是我们自己写入的 `<毫秒>-<原因>` 形态：时间戳可解析且原因
    // 落在五种已知值内（同时封死 `..` / 分隔符等路径穿越输入）
    let (created_at, reason) = parse_backup_id(backup_id);
    if created_at.is_none() || !BackupReason::ALL.iter().any(|r| r.as_str() == reason) {
        return Err(format!("BACKUP_NOT_FOUND: invalid backup id {backup_id}"));
    }
    let dir = fs_guard::join_safe(&backups_root(app_handle), profile_id)?;
    let zip_path = dir.join(format!("{backup_id}.zip"));
    if !zip_path.is_file() {
        return Err(format!("BACKUP_NOT_FOUND: backup {backup_id} does not exist"));
    }

    // 1) 解压到备份目录下的临时区并校验；任何校验失败都不触碰档案目录，
    //    服务也保持原状（无需恢复）。备份含凭据时返回其内容（写回在目录交换
    //    成功之后进行，避免失败时污染 `$DSH_HOME/.credentials.yaml`）。
    let tmp_root = dir.join(format!(".restore-{}-{}", std::process::id(), now_ms()));
    let tmp_profile = tmp_root.join("profile");
    let credentials = match zip::extract_and_validate(&zip_path, &tmp_profile, profile_id) {
        Ok(credentials) => credentials,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(e);
        }
    };
    // 2) 依赖重建标记先写入解压结果：还原不复制 node_modules，下次启动按
    //    manifest/lockfile 执行 pnpm install 重建所有直接依赖。标记写入失败时
    //    直接中止——此时档案目录与服务都未被触碰。
    if let Err(e) = crate::service::profile::mark_dependency_rebuild(&tmp_profile) {
        let _ = fs::remove_dir_all(&tmp_root);
        return Err(e);
    }

    // 3) 当前运行档案先停止 Harness：还原会替换目录，运行中替换会让服务读到
    //    半成品配置。从此处起任何失败都必须让前端恢复服务（SERVICE_STOPPED 前缀）。
    let profile_dir = profile_dir_of(app_handle, profile_id);
    let is_active = profile_id == active_profile(app_handle);
    let mut service_stopped = false;
    if is_active {
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(e);
        }
        service_stopped = true;
    }
    // 4) 还原前自动创建保护备份（档案目录存在时；失败即中止，先保住现状）。
    //    保护备份永远不带凭据：还原流程中复制密钥没有意义，且失败路径越少越好。
    if profile_dir.is_dir() {
        if let Err(e) = create_zip_backup(app_handle, profile_id, BackupReason::BeforeRestore, false) {
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(format!("SERVICE_STOPPED: {e}"));
        }
    }

    // 5) 交换目录：旧目录先整体挪到回收槽，再把解压内容换入；第二步失败时
    //    回滚放回旧目录，不留「档案目录消失」的数据丢失窗口。
    if profile_dir.exists() {
        let profiles_root = config::get_dsh_data_path(app_handle).join("profiles");
        let swap_slot = profiles_root.join(format!(
            ".restore-old-{}-{}",
            std::process::id(),
            now_ms()
        ));
        if let Err(e) = fs::rename(&profile_dir, &swap_slot) {
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(format!("SERVICE_STOPPED: BACKUP_REPLACE_SWAP_FAILED: {e}"));
        }
        if let Err(e) = fs::rename(&tmp_profile, &profile_dir) {
            // 回滚：宁可保留旧配置也不留空目录
            let _ = fs::rename(&swap_slot, &profile_dir);
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(format!("SERVICE_STOPPED: BACKUP_REPLACE_RENAME_FAILED: {e}"));
        }
        // 成功后清理旧配置与依赖产物（尽力而为；失败只告警，不影响还原结果）
        if !crate::service::download::remove_dir_with_retry(&swap_slot).await {
            log::warn!(
                "failed to remove old profile dir after restore: {}",
                swap_slot.display()
            );
        }
    } else {
        if let Some(parent) = profile_dir.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("BACKUP_MKDIR_FAILED: {e}"))?;
        }
        if let Err(e) = fs::rename(&tmp_profile, &profile_dir) {
            let _ = fs::remove_dir_all(&tmp_root);
            return Err(format!("SERVICE_STOPPED: BACKUP_REPLACE_RENAME_FAILED: {e}"));
        }
    }
    let _ = fs::remove_dir_all(&tmp_root);

    // 6) 备份含凭据时写回 `$DSH_HOME/.credentials.yaml`（临时文件 + 原子改名）。
    //    仅当备份确实携带凭据才覆盖；凭据写回失败只告警——档案已还原成功，
    //    不因此回滚（服务恢复与档案完整性优先）。
    if let Some(credentials) = credentials {
        let cred_path = config::get_dsh_data_path(app_handle).join(CREDENTIALS_FILE_NAME);
        let tmp_cred = cred_path.with_extension("tmp");
        if let Err(e) = fs::write(&tmp_cred, &credentials)
            .and_then(|_| fs::rename(&tmp_cred, &cred_path))
        {
            log::warn!(
                "failed to restore credentials for profile {profile_id}: {}: {e}",
                cred_path.display()
            );
        } else {
            log::info!("restored credentials file {}", cred_path.display());
        }
    }

    // 还原成功：推送一次事件让历史列表刷新（before_restore 已推送过一次）
    let _ = app_handle.emit(BACKUPS_UPDATED_EVENT, &serde_json::json!({ "profileId": profile_id }));

    let profile = crate::service::profile::list(app_handle)
        .into_iter()
        .find(|p| p.id == profile_id)
        .unwrap_or_else(|| Profile {
            id: profile_id.to_string(),
            name: display_name(app_handle, profile_id),
            description: crate::service::profile::description_of(app_handle, profile_id),
            default: profile_id == crate::service::profile::DEFAULT_PROFILE,
            active: is_active,
        });
    Ok(RestoreResult { profile, service_stopped })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_backup_id_extracts_timestamp_and_reason() {
        let (ms, reason) = parse_backup_id("1735000000000-config_change");
        assert_eq!(ms, Some(1_735_000_000_000));
        assert_eq!(reason, "config_change");
        let (ms, reason) = parse_backup_id("1735000000000-manual");
        assert_eq!(ms, Some(1_735_000_000_000));
        assert_eq!(reason, "manual");
        let (ms, _) = parse_backup_id("not-a-backup");
        assert_eq!(ms, None);
        let (ms, _) = parse_backup_id("123");
        assert_eq!(ms, None);
    }

    #[test]
    fn backup_reason_roundtrips_through_snake_case() {
        for reason in [
            BackupReason::Manual,
            BackupReason::Startup,
            BackupReason::Interval,
            BackupReason::ConfigChange,
            BackupReason::BeforeRestore,
        ] {
            let json = serde_json::to_string(&reason).unwrap();
            let back: BackupReason = serde_json::from_str(&json).unwrap();
            assert_eq!(reason, back, "reason {reason:?}");
        }
    }

    /// 构造临时备份目录：按创建时间写入若干假 ZIP（内容无需合法，只测列表/清理）。
    fn build_backup_dir(tag: &str, count: usize) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-backup-list-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..count {
            let base = 1_700_000_000_000i64 + i64::try_from(i).unwrap() * 1000;
            fs::write(dir.join(format!("{base}-manual.zip")), b"zip").unwrap();
        }
        dir
    }

    #[test]
    fn list_in_dir_sorts_by_created_at_and_ignores_state_file() {
        let dir = build_backup_dir("list", 3);
        fs::write(dir.join(STATE_FILE), "{}").unwrap();
        fs::write(dir.join("junk.txt"), "x").unwrap();
        let backups = list_in_dir(&dir).unwrap();
        assert_eq!(backups.len(), 3);
        assert_eq!(backups[0].created_at, 1_700_000_000_000);
        assert_eq!(backups[2].created_at, 1_700_000_002_000);
        assert_eq!(backups[0].reason, "manual");
        // profile_id 取自备份目录名
        assert_eq!(backups[0].profile_id, dir.file_name().unwrap().to_str().unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_keeps_newest_max_count() {
        let dir = build_backup_dir("prune", 5);
        prune(&dir, 3);
        let backups = list_in_dir(&dir).unwrap();
        assert_eq!(backups.len(), 3);
        assert_eq!(backups[0].created_at, 1_700_000_002_000);
        // 再清到 0 应保留 1 份以内
        prune(&dir, 0);
        assert!(list_in_dir(&dir).unwrap().len() <= 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_defaults_are_off_with_ten_retention() {
        let settings = ProfileBackupSettings::default();
        assert!(!settings.on_startup);
        assert!(!settings.on_change);
        assert_eq!(settings.interval_days, 0);
        assert_eq!(settings.max_count, 10);
        // 高级用户功能：默认不打扰（无凭据、无通知）
        assert!(!settings.include_credentials);
        assert!(!settings.notify);
    }

    #[test]
    fn interval_due_uses_most_recent_backup_time() {
        let now = 1_700_000_000_000i64;
        let day = 86_400_000i64;
        // 从未备份 → 到期
        assert!(interval_due_ms(None, now, 1));
        // 间隔 1 天：不足 24h 未到期
        assert!(!interval_due_ms(Some(now - day + 1), now, 1));
        // 恰好 24h → 到期
        assert!(interval_due_ms(Some(now - day), now, 1));
        // 间隔 7 天：6 天前未到期、7 天前到期
        assert!(!interval_due_ms(Some(now - 6 * day), now, 7));
        assert!(interval_due_ms(Some(now - 7 * day), now, 7));
    }

    #[test]
    fn auto_state_roundtrips_through_json() {
        let state = AutoState {
            last_fingerprint: Some("abc".into()),
            pending_fingerprint: None,
            pending_since_ms: None,
        };
        let json = serde_json::to_string(&state).unwrap();
        let back: AutoState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.last_fingerprint.as_deref(), Some("abc"));
        assert!(back.pending_fingerprint.is_none());
    }

    #[test]
    fn backup_id_validation_rejects_unknown_reasons_and_malformed_ids() {
        // 未知原因（路径穿越形态）一律拒绝
        for bad in [
            "1700000000000-weird",
            "1700000000000-../../evil",
            "not-a-backup",
            "..",
            "1700000000000-a/b",
        ] {
            let (created_at, reason) = parse_backup_id(bad);
            let valid = created_at.is_some() && BackupReason::ALL.iter().any(|r| r.as_str() == reason);
            assert!(!valid, "backup id {bad:?} 应被拒绝");
        }
        // 五种已知原因全部通过
        for reason in BackupReason::ALL {
            let id = format!("1700000000000-{}", reason.as_str());
            let (created_at, parsed) = parse_backup_id(&id);
            assert!(created_at.is_some());
            assert_eq!(parsed, reason.as_str());
        }
    }

    #[test]
    fn change_debounce_archives_only_after_stable_window() {
        let debounce = CONFIG_CHANGE_DEBOUNCE.as_millis() as u64;
        let fp = "fingerprint-B";
        // 无变化：不归档
        assert!(!change_should_archive(Some("A"), Some(fp), Some(0), "A", 100));
        // 首次跟踪（last 缺失）：不归档（基线由调用方处理）
        assert!(!change_should_archive(None, Some(fp), Some(0), fp, 100));
        // 防抖刚开始（pending 未记录）：不归档
        assert!(!change_should_archive(Some("A"), None, None, fp, 100));
        // pending 是旧指纹（期间又变化）：重新计时，不归档
        assert!(!change_should_archive(Some("A"), Some("C"), Some(0), fp, 100));
        // 稳定不足 10 秒：不归档
        assert!(!change_should_archive(Some("A"), Some(fp), Some(0), fp, debounce - 1));
        // 稳定恰好/超过 10 秒：归档
        assert!(change_should_archive(Some("A"), Some(fp), Some(0), fp, debounce));
        assert!(change_should_archive(Some("A"), Some(fp), Some(0), fp, debounce + 5000));
        // 无 pending 时间（异常状态）：不归档
        assert!(!change_should_archive(Some("A"), Some(fp), None, fp, debounce));
    }
}
