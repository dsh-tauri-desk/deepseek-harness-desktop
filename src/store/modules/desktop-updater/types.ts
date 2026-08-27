/** 由 @tauri-apps/plugin-updater 的 check() 映射出的桌面端新版本信息 */
export interface DesktopUpdateInfo {
  /** 最新可用版本号（无 v 前缀） */
  version: string
  /** 当前已安装版本号（无 v 前缀） */
  currentVersion: string
  /** 发布时间（ISO 字符串，可为空） */
  date: string | null
  /** 更新说明（可为空） */
  body: string | null
}

/** Rust 侧 get_desktop_about 返回的关于信息 */
export interface DesktopAboutInfo {
  version: string
  published_at: string
  copyright: string
  repo: string
  powered_by: string
}
