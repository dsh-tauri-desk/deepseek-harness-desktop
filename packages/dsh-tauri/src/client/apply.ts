/**
 * client/apply.ts — dsh-tauri 客户端插件体（browser half）：纯消息桥，无 UI、无运行时依赖。
 *
 * 本插件注册三件事：
 * - `registerSidebarToggle`（`./register/sidebar.ts`）：宿主导航栏的侧边栏开关经
 *   `dsh://sidebar:toggle` 转发给 dsh 布局服务（`ctx.layout.toggleSidebar()`）执行，
 *   并把侧边栏折叠状态回报给宿主；
 * - `registerZoomShortcut`（`./register/zoom-shortcut.ts`）：iframe 内的
 *   Ctrl/Cmd + `+`/`-`/`0` 经父窗口桥上报宿主（宿主写缩放真值，由 `useZoomFactor` 应用）；
 * - 侧边栏 UI 微调：官方侧边栏 logo 行自带的「收起侧边栏」按钮与宿主导航栏的开关重复，
 *   加载时用一条 CSS 规则隐藏（折叠态窄栏的「打开侧边栏」按钮保留）；同时把品牌词标
 *   按钮（aria-label「新建会话」，CSS module 类名是生成哈希、不稳定）的内容改为水平居中。
 *
 * 这三件事原先由桌面端注入的 `NAV_SHIM_JS` / `ZOOM_SHORTCUT_BRIDGE_JS` 承担，现在统一
 * 收敛到插件客户端（宿主只保留通知 / 样式 / 剪贴板图片 / boot 探测等无法在插件期实现的桥）。
 *
 * 服务依赖（inject）：layout（侧边栏切换）。locale/slots 均不再需要。
 */
import type { ClientContext } from './types'
import { CssRender } from 'css-render'
import {
  COLLAPSE_SIDEBAR_SELECTOR,
  NEW_SESSION_SELECTOR,
  SIDEBAR_TOGGLE_EFFECT_ID,
  SIDEBAR_TWEAKS_EFFECT_ID,
  SIDEBAR_TWEAKS_STYLE_ID,
  ZOOM_SHORTCUT_EFFECT_ID,
} from './constants'
import { registerSidebarToggle } from './register/sidebar'
import { registerZoomShortcut } from './register/zoom-shortcut'
import { reportPluginError } from './utils/error'

/**
 * 插件体：注册侧边栏（切换 + 折叠回报）、缩放快捷键与侧边栏 UI 微调。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ;(window as Window & { ctx?: ClientContext }).ctx = ctx

  // 侧边栏：宿主命令 → dsh 布局服务；折叠状态 → 宿主导航栏
  ctx.effect(
    () => registerSidebarToggle(() => { ctx.layout.toggleSidebar() }),
    SIDEBAR_TOGGLE_EFFECT_ID,
  )

  // 缩放快捷键：iframe 内捕获 → 父窗口桥 → 宿主缩放真值
  ctx.effect(() => registerZoomShortcut(), ZOOM_SHORTCUT_EFFECT_ID)

  ctx.effect(() => {
    // 侧边栏 UI 微调（一律用稳定的 aria-label 属性选择器，不用生成哈希的
    // CSS module 类名）：
    // 1. 隐藏 logo 行的「收起侧边栏」按钮：宿主导航栏已有侧边栏开关，应用内
    //    这个折叠按钮属于重复控件。只匹配折叠态文案（zh/en），窄栏恢复用的
    //    「打开侧边栏」按钮保留。
    // 2. 品牌词标按钮（与工具栏「新建会话」按钮共用 aria-label，后者本就
    //    居中，此规则对其是 no-op）默认 flex-start，改为水平居中。
    // CSS 选择器天然覆盖 React 后续重渲染，卸载时移除样式。
    let styleCleanup: (() => void) | undefined
    try {
      const cssr = CssRender()
      const { c } = cssr
      const style = c([
        c(COLLAPSE_SIDEBAR_SELECTOR, { display: 'none !important' }),
        c(NEW_SESSION_SELECTOR, { justifyContent: 'center !important' }),
      ])
      style.mount({ id: SIDEBAR_TWEAKS_STYLE_ID, head: true })
      styleCleanup = () => style.unmount({ id: SIDEBAR_TWEAKS_STYLE_ID })
    }
    catch (error) {
      // 插件自身代码路径异常：上报宿主，避免静默失败
      reportPluginError(error, 'runtime')
    }
    return () => styleCleanup?.()
  }, SIDEBAR_TWEAKS_EFFECT_ID)
}
