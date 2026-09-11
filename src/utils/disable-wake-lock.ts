/**
 * 禁用 Screen Wake Lock（屏幕唤醒锁）。
 *
 * 背景（issue #469）：桌宠窗口用 `<video>` 播放 WebM 动画，Chromium/WebView2 对
 * 「播放中（未暂停）的 video」**无条件**持有 Video Wake Lock——与窗口是否可见、
 * 是否 muted 都无关。锁一旦被持有，Windows 就无视「关闭显示器」超时，屏幕永远不黑
 * （且视频持续播放空占 CPU）。`收起宠物` 只是隐藏窗口，视频仍在播放，锁不会被释放。
 *
 * 本应用没有任何「保持屏幕常亮」的正当需求（长任务进度靠 UI/通知表达，不靠锁屏），
 * 因此直接在 WebView 内把 `navigator.wakeLock.request` 换成永远 reject 的实现：
 * 页面（含 dsh 界面、第三方代码、内置插件）后续任何申请都会立刻失败，Chromium 因
 * 此不再持有屏幕唤醒锁。方法被替换（而非删除 API）可让页面拿到明确的 Error，
 * 避免 `TypeError: navigator.wakeLock.request is not a function` 这类误导性崩溃。
 *
 * 幂等：两个入口（src/main.tsx 主窗口 / src/pet/main.tsx 桌宠窗口）都会调用，
 * 重复调用保留首次记录的原函数，恢复时不会把替换后的实现存成「原函数」。
 */

/** 被替换掉的原生实现；仅用于测试恢复环境，业务代码不应调用。 */
let originalRequest: WakeLock['request'] | undefined

/**
 * 标记「当前 request 已是本模块的禁用实现」。存在标记时直接跳过，使替换真正幂等
 * （不会把替换实现再包一层），也让 restoreWakeLock 能区分原生实现与自己的补丁。
 */
const DISABLED_MARKER: unique symbol = Symbol.for('deepseek-harness.wakeLockDisabled') as typeof DISABLED_MARKER

/** 打过补丁的 request：函数类型本身没有 symbol 键，用交叉类型描述这个运行时标记。 */
type MarkedRequest = WakeLock['request'] & { [DISABLED_MARKER]?: boolean }

/**
 * 把 `navigator.wakeLock.request` 替换为必失败的实现（幂等）。
 *
 * 无 Wake Lock API 的环境（旧 WebView2 / 非浏览器）直接 no-op。
 */
export function disableWakeLock(): void {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || navigator.wakeLock === undefined)
    return
  const wakeLock = navigator.wakeLock
  if ((wakeLock.request as MarkedRequest)[DISABLED_MARKER] === true)
    return
  originalRequest ??= wakeLock.request.bind(wakeLock)
  const request = function request(): Promise<WakeLockSentinel> {
    return Promise.reject(new Error('WAKELOCK_DISABLED: screen wake lock is disabled by DeepSeek Harness Desktop'))
  }
  // 打标记后重复调用直接返回，替换不会被套娃；restoreWakeLock 也据此区分原生实现。
  ;(request as MarkedRequest)[DISABLED_MARKER] = true
  wakeLock.request = request
}

/** 恢复原生实现并清理记录；仅供测试，业务代码不需要。 */
export function restoreWakeLock(): void {
  if (originalRequest === undefined)
    return
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && navigator.wakeLock !== undefined)
    navigator.wakeLock.request = originalRequest
  originalRequest = undefined
}
