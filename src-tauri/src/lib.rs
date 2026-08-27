mod bridge;
mod config;
pub mod desktop;
mod logger;
mod service;
mod task;
mod utils;

pub fn run() {
    // Wayland EGL workaround: AppImage bundles WebKitGTK may fail with
    // "Could not create default EGL display: EGL_BAD_PARAMETER" on Wayland
    // compositors (PikaOS/GNOME Wayland, Ubuntu 22.04+). Host WebKit (deb)
    // works, but AppImage needs compositing disabled. Auto-set when on Wayland
    // if user hasn't already set it — fixes hairyf#??? (PikaOS report).
    if std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "wayland" {
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
                crate::utils::show_main_window(app_handle);
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
            }
            _ => {}
        });
}
