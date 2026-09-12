mod bridge;
mod config;
pub mod desktop;
mod logger;
mod service;
mod task;
mod utils;

/// 应用入口：先做 Wayland 环境兼容（见 `should_apply_wayland_egl_workaround`），
/// 再初始化日志、装配桌面端并进入事件循环。
pub fn run() {
    // Wayland EGL workaround：仅 AppImage 需要（见 `should_apply_wayland_egl_workaround`）。
    if should_apply_wayland_egl_workaround(
        &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        std::env::var_os("APPIMAGE").is_some(),
    ) {
        // 与 README 文档一致地同时关闭 compositing 与 DMABUF renderer：只关前者在部分
        // 发行版/驱动上仍会 SIGSEGV（issue #116 的 WebKitGTK 崩溃）。两个参数互相独立，
        // 用户已手动设置其中一个时只补齐另一个。
        let mut applied = Vec::new();
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            applied.push("WEBKIT_DISABLE_COMPOSITING_MODE");
        }
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            applied.push("WEBKIT_DISABLE_DMABUF_RENDERER");
        }
        if !applied.is_empty() {
            // 此处在 logger::init() 之前执行，log 宏尚无 subscriber，用 eprintln 输出
            eprintln!("[wayland] set {} for WebKitGTK EGL", applied.join("="));
        }
    }
    // 初始化日志系统
    logger::init();

    desktop::builder()
        .invoke_handler(desktop::handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // macOS：关闭按钮只是隐藏窗口（见 builder 的 on_window_event），
            // 点击 Dock 图标时系统回调 applicationShouldHandleReopen 触发
            // RunEvent::Reopen，这里重新显示主窗口，否则窗口会一直隐藏在托盘。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                crate::utils::show_main_window(&app_handle);
            }
            // 正常退出请求发生在窗口销毁之前；此时主动保存一次主窗口几何，
            // 避免 Windows 最后一个移动/缩放事件尚未写入就退出而丢失尺寸。
            tauri::RunEvent::ExitRequested { .. } => {
                config::save_main_window_geometry(app_handle);
            }
            // 退出时回收 Harness 进程：不回收的话，node 进程会在应用退出后
            // 残留并把原生模块 DLL（如 sharp 的 libvips-42.dll）锁在内存，
            // 下次启动重新解压时会失败（Windows os error 32）
            tauri::RunEvent::Exit => {
                let setting = config::get_store_dat_setting(app_handle);
                if setting.installed {
                    service::workflow::stop_on_exit(app_handle.clone(), setting.port);
                }
                // 已下载但用户没在应用内安装过更新 → 退出后自动打开安装器：
                // 静默下载不打扰用户，代价是用户可能一直不主动升级，这里补上
                // 「关闭应用即升级」这一步（安装器由系统默认处理器启动）。
                service::update::launch_pending_installer(app_handle);
            }
            _ => {}
        });
}

/// Wayland EGL workaround 是否生效：仅 AppImage 需要。
///
/// AppImage 自带旧 WebKitGTK，打包库与宿主 Wayland 合成器 EGL 不兼容
/// （"Could not create default EGL display: EGL_BAD_PARAMETER"，PikaOS/GNOME
/// Wayland、Ubuntu 22.04+），必须关闭合成与 DMABUF renderer 才能建窗。
/// 宿主安装包（deb/rpm/…）用系统 WebKit，可正常创建 EGL 显示；且强制关闭合成
/// 会破坏透明窗口（桌宠）与视频渲染，因此非 AppImage 运行时不再强制。
/// AppImage 运行时必带 `APPIMAGE` 环境变量（runtime 规范），以此判定打包形态。
fn should_apply_wayland_egl_workaround(session_type: &str, appimage_present: bool) -> bool {
    session_type == "wayland" && appimage_present
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_workaround_only_inside_appimage() {
        // AppImage + Wayland：保留旧行为，窗口能建起来。
        assert!(should_apply_wayland_egl_workaround("wayland", true));
        // 宿主安装包 + Wayland：系统 WebKit 可建 EGL 显示，不再强制关闭合成
        //（否则透明桌宠窗口全黑、视频无法渲染）。
        assert!(!should_apply_wayland_egl_workaround("wayland", false));
        // 非 Wayland 会话：两种形态都不需要。
        assert!(!should_apply_wayland_egl_workaround("x11", true));
        assert!(!should_apply_wayland_egl_workaround("", true));
        assert!(!should_apply_wayland_egl_workaround("", false));
    }
}
