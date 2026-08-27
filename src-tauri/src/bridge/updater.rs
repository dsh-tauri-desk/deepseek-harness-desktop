//! 桌面端应用自身的更新与关于信息。
//!
//! 应用内自动更新（检查 / 下载 / 安装 / 重启）已交由 `tauri-plugin-updater`
//! 负责：前端通过 `@tauri-apps/plugin-updater` 的 JS API 直接调用（capabilities
//! 已授予 `updater:default`），不再经过自定义命令。本模块只保留：
//! - [`desktop_update_supported`]：当前安装形态是否支持应用内自动更新
//!   （Linux 仅 AppImage 支持；deb/rpm 安装不提示、走发布页手动下载）
//! - [`get_desktop_about`]：About 对话框信息

use crate::service::update;

/// 当前安装形态是否支持应用内自动更新。
///
/// `tauri-plugin-updater` 在 Linux 上仅支持 AppImage 部署：deb/rpm 安装的应用
/// （无 `APPIMAGE` 环境变量）即便 check 到更新，安装阶段也会因没有可替换的
/// AppImage 而失败。这里返回 `false` 让前端跳过更新提示，引导用户从发布页
/// 手动下载安装包。macOS / Windows 恒为 `true`。
#[tauri::command]
pub fn desktop_update_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// 关于对话框信息（版本 / 发布时间 / 版权 / 仓库）
#[tauri::command]
pub async fn get_desktop_about() -> Result<update::DesktopAboutInfo, String> {
    Ok(update::about().await)
}
