import type { Context } from '@deepseek-ai/cordis'

/**
 * locale.ts — 本插件文案（zh/en 双语）。命名空间 `panel`：
 * 克隆 SidebarRoot 的壳控制文案（新会话/折叠开关，与官方 sidebar NS 同值，
 * 但独立命名空间，互不干扰）。
 */
export const NS = 'panel'

const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
}

const en: Record<keyof typeof zh, string> = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
}

/** 注册面板文案命名空间（effect 生命周期，随插件卸载注销）。 */
export function installPanelLocale(ctx: Context): void {
  ctx.effect(
    () => {
      const disposeZh = ctx.locale.register(NS, 'zh', zh)
      const disposeEn = ctx.locale.register(NS, 'en', en)
      return () => {
        disposeZh()
        disposeEn()
      }
    },
    'dsh-tauri-panel: dictionaries',
  )
}
