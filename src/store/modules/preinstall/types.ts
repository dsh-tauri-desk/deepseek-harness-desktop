/** 预装插件列表项（与 Rust service::plugin::PreinstallPlugin 对齐） */
export interface PreinstallPlugin {
  id: string
  name: string
  description: string
  repo_url: string
  recommended: boolean
  /** “修复”类项（Windows 极简模式修复）：黄色 chip，默认勾选 */
  fix: boolean
  /** 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」） */
  defaultChecked: boolean
  installed: boolean
}

/** Rust 侧 preinstall-log 事件载荷（dsh plugin 进程输出行） */
export interface PreinstallLogPayload {
  line: string
}

/** 预装插件的安装/卸载 diff（前端比对勾选结果得出） */
export interface PreinstallSelection {
  installIds?: string[]
  uninstallIds?: string[]
}
