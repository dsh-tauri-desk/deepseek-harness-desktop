use super::constants::*;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Setting {
    pub installed: bool,
    pub port: u16,
    pub auto_start: bool,
    pub language: String,
    #[serde(default)]
    pub dsh_pkg_commit: Option<String>,
    /// 已安装 Harness 发行版对应的 GitHub release tag（与 dsh_pkg_commit 配套，
    /// 用于甄别“记录滞后于文件”与“同版本热修”两种不一致）
    #[serde(default)]
    pub dsh_pkg_tag: Option<String>,
    /// 命令行集成开关：安装后在用户 PATH 中注册 `dsh` 命令
    #[serde(default = "default_cli_link_enabled")]
    pub cli_link_enabled: bool,
    /// 预装插件引导是否已完成（确认安装或跳过都算完成，之后不再弹出）
    #[serde(default)]
    pub preinstall_done: bool,
    /// 上次引导结束时的 `preset-plugins.json` 内容指纹。资源文件每次安装都会被
    /// 强制覆盖、旧文件不复存在，只能把「上次看到的内容」记在这里，每次启动再比对：
    /// 内容有变更 → 重新进入预设引导。`None` = 老用户升级（无基线）→ 弹一次建立基线。
    #[serde(default)]
    pub preset_hash: Option<String>,
    /// 旧版 AppData `data/dsh` → 官方 `$DSH_HOME`（~/.dsh）数据迁移是否已完成。
    /// 幂等标记：迁移成功并删除旧目录后置位，避免重复合并。
    #[serde(default)]
    pub dsh_home_migrated: bool,
    /// 当前使用的档案 id（`$DSH_HOME/profiles/<id>`，默认 web）。
    /// 桌面端启动服务与插件管理都以它为准（见 service::profile）。
    #[serde(default = "default_active_profile")]
    pub active_profile: String,
    /// 活动核心的显式选择：`Some("local")` = 用户 CLI 安装的本地核心，
    /// `Some("app")` = 桌面端预打包核心；`None` = 自动（本地核心存在时优先）。
    #[serde(default)]
    pub active_core: Option<String>,
    /// 用户手动设置的服务端口（设置页「端口」输入，见 bridge::config）。
    /// 自动避让递增（配置端口被占 → 逐级顶高，见 workflow::launch）后，启动时
    /// 该端口空闲则回落回用户选择的值；`None` = 从未手动设置，回落目标为默认
    /// 端口（3080/3081）。避免端口只增不减、一路从 3080 漂到 3084+（issue #91）。
    #[serde(default)]
    pub manual_port: Option<u16>,
    /// 桌面主 WebView 的缩放比例。旧配置缺失时回落到 100%，读取与写入时均会
    /// 归一化到受支持的 50%–200% 范围和 10% 步长。
    #[serde(default = "default_zoom_factor")]
    pub zoom_factor: f64,
}

pub const ZOOM_FACTOR_MIN: f64 = 0.5;
pub const ZOOM_FACTOR_MAX: f64 = 2.0;
pub const ZOOM_FACTOR_STEP: f64 = 0.1;

/// 默认档案：桌面端内置的 web 档案
fn default_active_profile() -> String {
    "web".to_string()
}

/// 命令行集成默认开启（开发者工具场景，安装完成即可用）
fn default_cli_link_enabled() -> bool {
    true
}

/// 界面默认缩放为 100%。
pub fn default_zoom_factor() -> f64 {
    1.0
}

/// 将外部或旧存储中的缩放值限制到桌面端支持的稳定步长。
pub fn normalize_zoom_factor(value: f64) -> f64 {
    if !value.is_finite() {
        return default_zoom_factor();
    }
    let clamped = value.clamp(ZOOM_FACTOR_MIN, ZOOM_FACTOR_MAX);
    let steps_per_unit = 1.0 / ZOOM_FACTOR_STEP;
    (clamped * steps_per_unit).round() / steps_per_unit
}

/// 默认服务端口：debug 构建与生产隔离，避免开发时与已运行的桌面端争用 3080。
pub fn default_port() -> u16 {
    if cfg!(debug_assertions) {
        DSH_DEV_PORT
    } else {
        DSH_PORT
    }
}

impl Default for Setting {
    fn default() -> Self {
        Self {
            installed: false,
            port: default_port(),
            auto_start: true,
            language: "zh-CN".to_string(),
            dsh_pkg_commit: None,
            dsh_pkg_tag: None,
            cli_link_enabled: default_cli_link_enabled(),
            preinstall_done: false,
            preset_hash: None,
            dsh_home_migrated: false,
            active_profile: default_active_profile(),
            active_core: None,
            manual_port: None,
            zoom_factor: default_zoom_factor(),
        }
    }
}

/// Store 持久化文件名：debug 构建与生产隔离（各自独立文件）。
///
/// store（端口、installed、active_core 等）属于「应用数据」而非共用核心——
/// 生产默认 3080、开发默认 3081，共用一份 store 会让两边端口一路漂移
/// （release 读到开发写入的 3081 后把 3080 让出，开发下次又从 3081 漂走）
/// 并相互污染安装/核心等状态。
fn store_dat_file_name() -> &'static str {
    if cfg!(debug_assertions) {
        STORE_DAT_DEV_FILE
    } else {
        STORE_DAT_FILE
    }
}

fn setting_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_store_dat_setting(app_handle: &AppHandle) -> Setting {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store");
    let raw = store.get(STORE_SETTING_KEY);
    let value = raw.as_ref().and_then(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| Some(v.clone()))
    });
    let mut setting = value
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(Setting::default);
    setting.zoom_factor = normalize_zoom_factor(setting.zoom_factor);
    setting
}

fn write_store_dat_setting(app_handle: &AppHandle, setting: &Setting) -> serde_json::Value {
    let store = app_handle
        .store(store_dat_file_name())
        .expect("Failed to load store");
    let value = serde_json::to_value(setting).unwrap();
    store.set(STORE_SETTING_KEY, value.clone());
    store.save().expect("Failed to save store");
    value
}

fn emit_setting(app_handle: &AppHandle, value: &serde_json::Value) {
    app_handle
        .emit("setting_updated", value)
        .expect("Failed to emit event");
}

fn preserve_persisted_zoom(mut replacement: Setting, persisted_zoom: f64) -> Setting {
    replacement.zoom_factor = normalize_zoom_factor(persisted_zoom);
    replacement
}

/// 兼容旧调用方的整对象写入，但始终保留锁内读到的最新缩放，避免长流程用陈旧
/// `Setting` 覆盖刚刚由快捷键写入的值。
pub fn set_store_dat_setting(app_handle: &AppHandle, setting: Setting) {
    let value = {
        let _guard = setting_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = read_store_dat_setting(app_handle);
        let setting = preserve_persisted_zoom(setting, current.zoom_factor);
        write_store_dat_setting(app_handle, &setting)
    };
    emit_setting(app_handle, &value);
}

/// 在一个短临界区内读取、修改并写回设置，避免多个精确字段更新彼此丢失。
pub fn update_store_dat_setting<F>(app_handle: &AppHandle, update: F) -> Setting
where
    F: FnOnce(&mut Setting),
{
    let (setting, value) = {
        let _guard = setting_write_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut setting = read_store_dat_setting(app_handle);
        update(&mut setting);
        setting.zoom_factor = normalize_zoom_factor(setting.zoom_factor);
        let value = write_store_dat_setting(app_handle, &setting);
        (setting, value)
    };
    emit_setting(app_handle, &value);
    setting
}

pub fn set_store_dat_zoom_factor(app_handle: &AppHandle, zoom_factor: f64) -> Setting {
    update_store_dat_setting(app_handle, |setting| {
        setting.zoom_factor = zoom_factor;
    })
}

pub fn get_store_dat_setting(app_handle: &AppHandle) -> Setting {
    let _guard = setting_write_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    read_store_dat_setting(app_handle)
}

/// 已安装 Harness 发行版对应的 GitHub release commit hash
pub fn get_dsh_pkg_commit(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_commit
}

/// 记录已安装 Harness 发行版的 GitHub release commit hash
pub fn set_dsh_pkg_commit(app_handle: &AppHandle, commit: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_commit = Some(commit);
    set_store_dat_setting(app_handle, setting);
}

/// 已安装 Harness 发行版对应的 GitHub release tag
pub fn get_dsh_pkg_tag(app_handle: &AppHandle) -> Option<String> {
    get_store_dat_setting(app_handle).dsh_pkg_tag
}

/// 记录已安装 Harness 发行版的 GitHub release tag
pub fn set_dsh_pkg_tag(app_handle: &AppHandle, tag: String) {
    let mut setting = get_store_dat_setting(app_handle);
    setting.dsh_pkg_tag = Some(tag);
    set_store_dat_setting(app_handle, setting);
}

#[cfg(test)]
mod tests {
    use super::{
        default_zoom_factor, normalize_zoom_factor, preserve_persisted_zoom, Setting,
        ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN,
    };

    #[test]
    fn zoom_factor_defaults_for_legacy_settings() {
        let setting: Setting = serde_json::from_value(serde_json::json!({
            "installed": true,
            "port": 3080,
            "auto_start": true,
            "language": "en-US"
        }))
        .expect("legacy setting should deserialize");

        assert_eq!(setting.zoom_factor, default_zoom_factor());
    }

    #[test]
    fn zoom_factor_is_clamped_and_rounded() {
        assert_eq!(normalize_zoom_factor(0.1), ZOOM_FACTOR_MIN);
        assert_eq!(normalize_zoom_factor(3.0), ZOOM_FACTOR_MAX);
        assert!((normalize_zoom_factor(1.14) - 1.1).abs() < f64::EPSILON);
        let canonical = normalize_zoom_factor(1.16);
        assert_eq!(canonical, 1.2);
        assert_eq!(serde_json::to_string(&canonical).unwrap(), "1.2");
    }

    #[test]
    fn invalid_zoom_factor_resets_to_default() {
        assert_eq!(normalize_zoom_factor(f64::NAN), default_zoom_factor());
        assert_eq!(normalize_zoom_factor(f64::INFINITY), default_zoom_factor());
    }

    #[test]
    fn legacy_full_setting_write_preserves_latest_zoom() {
        let mut stale = Setting::default();
        stale.zoom_factor = 0.8;

        let merged = preserve_persisted_zoom(stale, 1.6);

        assert_eq!(merged.zoom_factor, 1.6);
    }
}
