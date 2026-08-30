//! Minimal backend i18n for user-facing errors.
//!
//! The frontend owns the rich UI language state; the backend only needs a few
//! translated strings for errors that may surface in logs or returned messages.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

static CURRENT_LANG: AtomicU8 = AtomicU8::new(0); // 0 = zh, 1 = en

pub fn set_language(lang: Lang) {
    CURRENT_LANG.store(
        match lang {
            Lang::Zh => 0,
            Lang::En => 1,
        },
        Ordering::SeqCst,
    );
}

fn lang() -> Lang {
    if CURRENT_LANG.load(Ordering::SeqCst) == 1 {
        Lang::En
    } else {
        Lang::Zh
    }
}

/// Look up a translation key. Keys are grouped by domain with `_` separators.
pub fn t(key: &str) -> String {
    let (zh, en): (&str, &str) = match key {
        "profile.clone_of" => ("克隆自 {}", "Cloned from {}"),
        "runtime.unsupported_platform" => {
            ("不支持当前平台/架构", "Unsupported platform/architecture")
        }
        "runtime.title" => ("Node.js 运行时", "Node.js runtime"),
        "runtime.not_found" => (
            "Node.js 运行时不存在，请先完成安装",
            "Node.js runtime not found, run setup first",
        ),
        "runtime.incompatible" => (
            "Node.js 运行时不兼容，需要 Node 22.19+（仅 22.x）或 Node 24+",
            "Node.js runtime is incompatible; need Node 22.19+ (22.x only) or Node 24+",
        ),
        "harness.title" => ("DeepSeek Harness 核心", "DeepSeek Harness core"),
        "harness.core_not_found" => (
            "未找到 DeepSeek Harness 核心包，请先完成安装",
            "DeepSeek Harness core package not found, run setup first",
        ),
        "harness.manifest_invalid" => ("Harness 包清单无效", "Invalid harness package manifest"),
        "harness.asset_not_found" => (
            "发布资源中未找到匹配的平台包",
            "No matching platform asset found in the release",
        ),
        "harness.hash_mismatch" => (
            "下载文件哈希校验失败",
            "Downloaded file hash verification failed",
        ),
        "harness.start_failed" => (
            "启动 DeepSeek Harness 服务失败",
            "Failed to start DeepSeek Harness service",
        ),
        "harness.health_unhealthy" => (
            "DeepSeek Harness 服务未就绪",
            "DeepSeek Harness service is not ready",
        ),
        "process.manager_poisoned" => ("进程管理器状态异常", "Process manager state is corrupted"),
        "config.load_failed" => ("读取配置失败", "Failed to load configuration"),
        "config.save_failed" => ("保存配置失败", "Failed to save configuration"),
        "download.failed" => ("下载失败", "Download failed"),
        "install.downloading" => ("正在下载", "Downloading"),
        "install.extracting" => ("正在解压", "Extracting"),
        "install.downloaded" => ("已下载", "Downloaded"),
        "install.done" => ("依赖已安装完毕", "Dependencies installed"),
        "menu.application" => ("应用", "Application"),
        "menu.help" => ("帮助", "Help"),
        "menu.settings" => ("设置…", "Settings…"),
        "menu.enter_fullscreen" => ("进入全屏幕", "Enter Full Screen"),
        "menu.exit_fullscreen" => ("退出全屏幕", "Exit Full Screen"),
        "menu.about" => ("关于 Desktop", "About Desktop"),
        "menu.run_logs" => ("运行日志", "Run Logs"),
        "menu.check_update" => ("检查更新", "Check for Updates"),
        "menu.edit" => ("编辑", "Edit"),
        "menu.undo" => ("撤销", "Undo"),
        "menu.redo" => ("重做", "Redo"),
        "menu.cut" => ("剪切", "Cut"),
        "menu.copy" => ("复制", "Copy"),
        "menu.paste" => ("粘贴", "Paste"),
        "menu.select_all" => ("全选", "Select All"),
        "backup.reason.manual" => ("手动", "Manual"),
        "backup.reason.startup" => ("启动", "Startup"),
        "backup.reason.interval" => ("周期", "Periodic"),
        "backup.reason.config_change" => ("配置变化", "Config change"),
        "backup.reason.before_restore" => ("还原前", "Before restore"),
        "backup.notify_success_title" => ("档案备份完成", "Profile backup completed"),
        "backup.notify_failed_title" => ("档案备份失败", "Profile backup failed"),
        "backup.notify_success_body" => ("档案 {} 已自动备份（{}）", "Profile {} backed up automatically ({})"),
        "backup.notify_failed_body" => ("档案 {} 自动备份失败（{}）", "Profile {} auto backup failed ({})"),
        _ => (key, key),
    };
    match lang() {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
    }
}

/// 用参数依次替换模板中的 `{}` 占位符（Rust `format!` 要求字面量，
/// i18n 文案是运行时字符串，这里手写填充）。
pub fn fill_template(template: &str, args: &[&str]) -> String {
    let mut out = String::new();
    let mut rest = template;
    for arg in args {
        match rest.find("{}") {
            Some(pos) => {
                out.push_str(&rest[..pos]);
                out.push_str(arg);
                rest = &rest[pos + 2..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}
