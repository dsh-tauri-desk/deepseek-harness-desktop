declare global {
  interface Window {
    /** 插件接管标记：桌面端 NAV_SHIM_JS 检测到后停止收发，避免双重执行。 */
    __dsh_tauri_bridge__?: boolean
  }
}

export {}
