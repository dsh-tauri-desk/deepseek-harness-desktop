/** 宿主命令所需的业务面（由插件体注入 ctx.layout）。 */
export interface NavBridgeHandlers {
  toggleSidebar: () => void
}

/** 会话访问栈中的页面。 */
export interface Page {
  key: string | null
  el: HTMLElement | null
}

/** 记录动作（与宿主 `PluginError.action` 语义一致）。 */
export type ErrorAction = 'runtime' | 'install' | 'update' | 'remove'
