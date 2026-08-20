#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Arc;

use tauri::{
    ipc::Invoke,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Runtime, WebviewUrl, WebviewWindowBuilder, Wry,
};

use crate::core::utils::show_main_window;
use crate::desktop::window::{on_download, on_new_window};
#[cfg(windows)]
use crate::desktop::window::on_page_load;

/// setup app
pub fn setup(app_handle: tauri::AppHandle) {
    // 启动进程监控（tick 检测 dsh 服务状态）
    crate::service::scheduler::start(&app_handle);

    // 开机自启动：已安装且开启 auto_start 时拉起服务
    let app_for_start = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_for_start);
        if !setting.auto_start {
            log::debug!("auto_start disabled, skipping startup");
            return;
        }
        if let Err(e) = crate::service::workflow::start(app_for_start).await {
            log::error!("start failed: {}", e);
        }
    });

    // 命令行集成自愈：已安装且开启时，确保 shim 与 PATH 注册完整
    // （shim 被删除、PATH 条目丢失等情况下自动重建）
    tauri::async_runtime::spawn(async move {
        let setting = crate::config::get_store_dat_setting(&app_handle);
        if !setting.installed || !setting.cli_link_enabled {
            return;
        }
        if let Err(e) = crate::service::cli::ensure(&app_handle) {
            log::warn!("cli link self-heal failed: {e}");
        }
    });
}

/// setup tray
pub fn tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    // 使用默认窗口图标
    let icon = app.default_window_icon().unwrap().clone();

    // 构建菜单
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )?;

    fn handle_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: &MenuEvent) {
        match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        }
    }

    fn handle_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: &TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    }

    // 构建托盘图标
    let _ = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Deepseek Harness Desktop")
        .on_menu_event(move |app, event| handle_menu_event(app, &event))
        .on_tray_icon_event(move |tray, event| handle_tray_icon_event(tray, &event))
        .build(app)?;

    Ok(())
}

/// 构建主窗口。
///
/// 主窗口在这里手动创建（不再从 tauri.conf.json 声明）：
/// config 声明的窗口无法挂载 on_download，而内嵌 iframe 的 dsh 页面
/// 触发下载时 WebView2 静默保存、用户零感知，需要接管下载以给出反馈。
pub fn build_main_window(app: &tauri::AppHandle<Wry>) -> tauri::Result<tauri::WebviewWindow<Wry>> {
    let app_handle = app.clone();

    #[cfg(windows)]
    let _notification_handlers_registered = Arc::new(AtomicBool::new(false));
    #[cfg(windows)]
    let notification_handlers_registered_for_page = _notification_handlers_registered.clone();

    let webview_builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Deepseek Harness Desktop")
            .inner_size(1280.0, 840.0)
            .min_inner_size(860.0, 620.0)
            .resizable(true)
            // 无系统标题栏：窗口 chrome 由壳层 ShellNavBar 常驻提供
            // （44px 顶部导航：左侧 iframe 导航控制 + 右侧窗口控制）
            .decorations(false)
            // 恢复 iframe 内 HTML5 拖拽（拖入图片/拖动元素）：
            // Tauri 默认注册 wry drag_drop_handler → WebView2 SetAllowExternalDrop(false)
            // 并注入 IDropTarget 接管拖放，iframe 内拖拽被禁用。
            // 注意不能用 .drag_and_drop(false)：它只设置 tao 窗口层的拖放开关
            // （tauri issue #13761），不影响 webview 层，拖拽依旧失效；
            // disable_drag_drop_handler 才能关掉 wry 的接管（等价于旧配置 dragDropEnabled: false）。
            .disable_drag_drop_handler()
            // 接管内嵌 iframe 的 window.open() / target=_blank 新窗口请求：
            // WebView2 里这类请求走 NewWindowRequested，wry 在没有 handler 时
            // 直接 SetHandled(true) 吞掉（点了没反应）——dshmarket 等预设插件的
            // “源码”按钮在桌面端因此无法跳转（浏览器里正常）。
            // 这里把 http(s) 链接交给系统浏览器打开，其余协议一律拒绝。
            .on_new_window(move |url, features| on_new_window(app_handle.clone(), url, features))
            .on_download(|webview, event| on_download(webview, event));

    #[cfg(windows)]
    let webview_builder = webview_builder.on_page_load(move |webview_window, payload| {
        on_page_load(
            webview_window,
            payload,
            notification_handlers_registered_for_page.clone(),
        )
    });

    // 非 Windows（macOS/Linux）没有 WebView2 的 FrameCreated/ContentLoading 流程，
    // 直接用 Tauri 的 initialization_script_for_all_frames 把通知桥、导航桥与样式桥注入
    // 所有 frame（脚本均带 window.__dsh_*_bridge__ 幂等守卫，重复注入安全）。
    #[cfg(not(windows))]
    let webview_builder = webview_builder
        .initialization_script_for_all_frames(crate::desktop::notification::NOTIFICATION_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::nav::NAV_SHIM_JS)
        .initialization_script_for_all_frames(crate::desktop::style::IFRAME_STYLES_JS);

    let webview_window = webview_builder.build()?;

    #[cfg(windows)]
    {
        if !_notification_handlers_registered.swap(true, Ordering::SeqCst) {
            log::info!("[notification] scheduling handler registration from setup");
            let webview_for_dialog = webview_window.clone();
            if let Err(e) = webview_window.with_webview(move |webview| {
                if let Err(e) = crate::desktop::notification::enable_notification_permissions(
                    webview,
                    webview_for_dialog,
                ) {
                    log::warn!("[webview] failed to enable notification permission: {e}");
                }
            }) {
                log::warn!("[webview] failed to schedule notification permission setup: {e}");
            }
        }
    }

    Ok(webview_window)
}

// configure invoke handler
pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::bridge::cmd::install_dependencies,
        crate::bridge::cmd::check_dsh_update,
        crate::bridge::cmd::launch_harness,
        crate::bridge::cmd::shutdown_harness,
        crate::bridge::cmd::restart_harness,
        crate::bridge::cmd::get_dsh_status,
        crate::bridge::cmd::get_preinstall_plugins,
        crate::bridge::cmd::get_preinstall_pending,
        crate::bridge::cmd::install_preinstall_plugins,
        crate::bridge::cmd::cancel_preinstall_plugins,
        crate::bridge::cmd::skip_preinstall_plugins,
        crate::bridge::cmd::open_preinstall_repo,
        crate::bridge::cmd::get_dsh_plugins,
        crate::bridge::cmd::remove_dsh_plugin,
        crate::bridge::cmd::proxy_health_check,
        crate::bridge::cmd::get_runtime_info,
        crate::bridge::cmd::runtime_ready,
        crate::bridge::cmd::get_app_config,
        crate::bridge::cmd::update_app_config,
        crate::bridge::cmd::get_cli_link_status,
        crate::bridge::cmd::open_in_browser,
        crate::bridge::cmd::copy_service_url,
        crate::bridge::cmd::reveal_data_dir,
        crate::bridge::cmd::reveal_in_folder,
        crate::bridge::cmd::read_service_logs,
        crate::bridge::cmd::clear_service_logs,
        crate::bridge::cmd::set_language,
        crate::bridge::cmd::toggle_sidebar,
        crate::bridge::cmd::get_dsh_theme,
        crate::bridge::cmd::check_desktop_update,
        crate::bridge::cmd::download_desktop_update,
        crate::bridge::cmd::open_desktop_installer,
        crate::bridge::cmd::get_desktop_about,
        crate::bridge::cmd::open_external_url,
        crate::desktop::notification::show_native_notification,
    ]
}

// configure tauri builder
pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();
            build_main_window(&app_handle)?;
            tray(&app_handle)?;
            setup(app_handle.clone());
            Ok(())
        })
        // 点击关闭按钮时隐藏到托盘而不是退出程序
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        // 单例模式：多次双击图标（或重复启动）时不会新开窗口，而是把
        // 已存在的（可能已隐藏到托盘）主窗口调到前台，实现“单例 + 复用后台窗口”。
        // 该回调在首次启动时也会以当前进程的参数触发一次（幂等，仅 show/focus），
        // 之后每次二次启动都会派发到这里，重新展示后台运行的主窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            crate::core::utils::show_main_window(app);
        }))
        // Opener plugin
        .plugin(tauri_plugin_opener::init())
        // Notification plugin（Windows 上以 tauri-winrt-notification 实现点击回调，
        // 注册官方插件保留跨平台回退能力）
        .plugin(tauri_plugin_notification::init())
        // FS plugin
        .plugin(tauri_plugin_fs::init())
        // Simple Store plugin
        .plugin(tauri_plugin_store::Builder::new().build())
        // Clipboard plugin
        .plugin(tauri_plugin_clipboard_manager::init())
}
