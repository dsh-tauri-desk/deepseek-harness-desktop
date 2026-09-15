/**
 * 错误上报桥（iframe 内 → 桌面宿主）。
 *
 * 与桌面端入站桥（`src/layout/components/iframe.tsx`）的协议逐字一致 —— 宿主按
 * `type` 分发，任何一处不一致都会被静默丢弃：
 *
 *   { type: 'dsh://plugin-error', id, error, action }
 *
 * 宿主收到后经 `report_plugin_error` 持久化到插件错误注册表
 * （plugin-errors.json，按插件 id 幂等覆盖并推送新列表），「插件」面板据此
 * 给本插件显示 danger 标记与更新/卸载入口。
 *
 * 发送统一走 `invokeParent`（父窗口桥唯一出口），不再自己 `postMessage`。
 */
import type { ErrorAction } from '../types'
import { ERROR_TYPE, PLUGIN_ID } from '../constants'
import { invokeParent } from '../service/invoke-parent'

export { ERROR_TYPE, PLUGIN_ID } from '../constants'
export type { ErrorAction } from '../types'

/**
 * 上报插件运行期错误到宿主。
 * @param error 错误对象/消息（宿主截断保留 2000 字符）
 * @param action 记录动作，默认 runtime
 */
export function reportPluginError(error: unknown, action: ErrorAction = 'runtime'): void {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .trim()
    .slice(0, 2000)
  if (!message)
    return
  invokeParent({ type: ERROR_TYPE, id: PLUGIN_ID, error: message, action })
}

/**
 * 把可能抛错的回调包装成「捕获 + 上报 + 继续执行」的安全回调：
 * 观测器/监听器回调一旦抛错会变成 uncaught error，宿主无从知晓；包装后统一
 * 上报为本插件的 runtime 错误。
 *
 * 注意只包插件自身代码路径，**不**监听全局 error/unhandledrejection —— dsh
 * 应用与本插件共享同一页面，全量捕获会把整个应用的异常都记到本插件名下，
 * 污染宿主错误注册表。
 */
export function guard<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  return (...args: T) => {
    try {
      fn(...args)
    }
    catch (error) {
      reportPluginError(error, 'runtime')
    }
  }
}
