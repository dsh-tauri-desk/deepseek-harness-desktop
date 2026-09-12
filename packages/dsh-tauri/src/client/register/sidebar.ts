/**
 * register/sidebar.ts — 侧边栏（宿主顶部导航栏 ↔ iframe），两个方向各一件事：
 *
 * - 宿主 → iframe：导航栏开关把 `dsh://sidebar:toggle` 发进来，用 dsh 应用自己的布局
 *   服务（`ctx.layout.toggleSidebar()`）执行切换 —— 不依赖 DOM 结构与界面文案；
 * - iframe → 宿主：观察 AppFrame 的 `data-sidebar-collapsed`，变化即回报
 *   `dsh://sidebar:collapsed`，供宿主导航栏同步折叠图标。
 *
 * 桌面端不再注入导航桥脚本（`NAV_SHIM_JS`）：切换与折叠回报都由本注册承担，
 * 插件缺席时导航栏本来也不渲染侧边栏控件（宿主按 dsh-tauri 是否已安装判断）。
 */
import {
  CMD_TOGGLE,
  EVENT_SIDEBAR_COLLAPSED,
  SIDEBAR_COLLAPSED_ATTRIBUTE,
  SIDEBAR_FRAME_SELECTOR,
  SIDEBAR_TRACK_INTERVAL_MS,
  SIDEBAR_TRACK_MAX_TRIES,
} from '../constants'
import { createLifecycleController } from '../controller'
import { invokeParent } from '../service/invoke-parent'
import { listenParent } from '../service/listen-parent'
import { reportPluginError } from '../utils/error'

/** AppFrame：dsh 应用布局的根（`data-shell-overlay` 的父节点）。 */
function findFrame(): HTMLElement | null {
  const overlay = document.querySelector<HTMLElement>(SIDEBAR_FRAME_SELECTOR)
  return overlay?.parentElement ?? null
}

/**
 * 注册侧边栏切换（宿主命令 → dsh 布局服务）与折叠状态回报（dsh → 宿主）。
 * @param toggleSidebar 切换动作（插件体注入 `ctx.layout.toggleSidebar`）。
 * @returns 卸载函数（注销命令监听、折叠观察与补报轮询）。
 */
export function registerSidebarToggle(toggleSidebar: () => void): () => void {
  const controller = createLifecycleController()

  /** 折叠状态回报（幂等：宿主只把它写进状态） */
  function reportCollapsed(): void {
    invokeParent({
      type: EVENT_SIDEBAR_COLLAPSED,
      collapsed: !!findFrame()?.hasAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE),
    })
  }

  // 宿主命令：切换侧边栏
  controller.add(listenParent<{ type?: string }>((data) => {
    if (data.type !== CMD_TOGGLE)
      return
    try {
      toggleSidebar()
    }
    catch (error) {
      // 布局服务抛错：上报宿主（插件面板据此显示异常标记），不影响后续命令
      reportPluginError(error, 'runtime')
    }
  }, [CMD_TOGGLE]))

  // 折叠状态：属性翻转即回报（AppFrame 出现后属性变化都会命中）
  controller.observe(document.body, {
    attributes: true,
    attributeFilter: [SIDEBAR_COLLAPSED_ATTRIBUTE],
    subtree: true,
  }, reportCollapsed)

  // 首次回报：应用早于插件挂载时属性不会产生变化事件；
  // 应用晚挂载则轮询到 AppFrame 出现为止（有界，拿到即停）。
  reportCollapsed()
  let tries = 0
  const stopPoll = controller.interval(() => {
    const ready = !!findFrame()
    if (ready || ++tries > SIDEBAR_TRACK_MAX_TRIES) {
      if (ready)
        reportCollapsed()
      stopPoll()
    }
  }, SIDEBAR_TRACK_INTERVAL_MS)

  return () => controller.dispose()
}
