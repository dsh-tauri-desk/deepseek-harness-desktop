/**
 * register/zoom-shortcut.ts — iframe 内的缩放快捷键（Ctrl/Cmd + `+` / `-` / `0`）。
 *
 * 跨域 iframe 里的按键不会冒泡到桌面壳层，因此由本注册在 iframe 内以捕获阶段监听，
 * 命中后 `preventDefault` 并经父窗口桥上报动作；宿主（`layout/components/iframe.tsx`
 * 的 `dsh://zoom-shortcut` 分支）把它写进 `store.setting.zoom_factor` 真值，再由
 * `useZoomFactor` 应用到 WebView。
 *
 * 壳层自身获得焦点时的快捷键由宿主自己的监听处理，两端口径一致（见 `utils/zoom.ts`）。
 * 桌面端不再注入 `ZOOM_SHORTCUT_BRIDGE_JS`：插件在场即由本注册承担。
 */
import { TYPE_ZOOM_SHORTCUT } from '../constants'
import { invokeParent } from '../service/invoke-parent'
import { zoomActionFromShortcut } from '../utils/zoom'

/**
 * 注册缩放快捷键：捕获 iframe 内的缩放按键并上报宿主。
 * @returns 卸载函数。
 */
export function registerZoomShortcut(): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    const action = zoomActionFromShortcut(event)
    if (!action)
      return
    event.preventDefault()
    invokeParent({ type: TYPE_ZOOM_SHORTCUT, action })
  }

  window.addEventListener('keydown', onKeyDown, { capture: true })
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
}
