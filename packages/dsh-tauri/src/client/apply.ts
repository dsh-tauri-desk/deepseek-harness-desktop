/**
 * client/apply.ts — dsh-tauri 客户端插件体（browser half）：纯消息桥，无 UI、无运行时依赖。
 *
 * 桌面端顶部导航栏（shell-nav-bar.tsx）常驻在 Tauri 宿主，其左侧三个控件
 * （侧边栏 / 后退 / 前进）通过 postMessage 操控 iframe 内的 dsh 应用；
 * 本插件是 iframe 内的接收端：把命令转发给 dsh（侧边栏切换走
 * `ctx.layout.toggleSidebar`，后退/前进走 `window.history`），并把 dsh 状态
 * （侧边栏折叠、页面历史边界）回报给宿主。协议详见 `./service/bridge.ts`。
 *
 * 另：官方侧边栏 logo 行自带的「收起侧边栏」按钮与宿主顶部导航栏的侧边栏
 * 开关重复，插件加载时用一条 CSS 规则把它隐藏（折叠态窄栏的「打开侧边栏」
 * 按钮保留，窄栏恢复仍靠它）；同时把品牌词标按钮（aria-label「新建会话」，
 * CSS module 类名是生成哈希、不稳定）的内容改为水平居中。
 *
 * 服务依赖（inject）：layout（侧边栏切换）。locale/slots 均不再需要。
 */
import type { ClientContext } from './types'
import { CssRender } from 'css-render'
import {
  COLLAPSE_SIDEBAR_SELECTOR,
  NAV_BRIDGE_EFFECT_ID,
  NEW_SESSION_SELECTOR,
  SIDEBAR_TWEAKS_EFFECT_ID,
  SIDEBAR_TWEAKS_STYLE_ID,
} from './constants'
import { setupNavBridge } from './service/bridge'
import { reportPluginError } from './utils/error'

/**
 * 插件体：接管导航桥（置位接管标记 → 挂命令监听/状态观察/历史跟踪）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ;(window as Window & { ctx?: ClientContext }).ctx = ctx

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

  ctx.effect(() => {
    // 导航桥启动：初始化失败也上报（桥内部有各自的 guard/兜底轮询，这里只
    // 兜 setupNavBridge 首次同步执行期间的异常）。
    let navCleanup: (() => void) | undefined
    try {
      navCleanup = setupNavBridge({
        toggleSidebar: () => { ctx.layout.toggleSidebar() },
      })
    }
    catch (error) {
      reportPluginError(error, 'runtime')
    }
    return () => navCleanup?.()
  }, NAV_BRIDGE_EFFECT_ID)
}
