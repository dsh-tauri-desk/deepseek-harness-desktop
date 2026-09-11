/**
 * 禁用 Screen Wake Lock（页面可申请的「屏幕唤醒锁」）。
 *
 * 背景（issue #469）：桌宠窗口用 `<video>` 播放 WebM 动画，播放期间系统无法息屏——
 * Windows 无视「关闭显示器」超时，屏幕永远不黑，还长时间空占 CPU。
 *
 * # 这里挡的是哪把锁（两把锁不要混淆）
 *
 * 1. **Screen Wake Lock（本模块）**：页面经 `navigator.wakeLock.request('screen')`
 *    主动申请的锁。任何页面代码（dsh 界面、第三方代码、内置插件）都能申请，本应用
 *    没有任何常亮的正当需求，因此整体禁掉。
 * 2. **Video Wake Lock（不由本模块负责）**：Chromium/WebView2 内部对「播放中
 *    （未暂停）的 `<video>`」**无条件**申请的 `kPreventDisplaySleep`，与页面是否调用
 *    wakeLock API、与 muted / 窗口可见性都无关。禁用本模块的 `navigator.wakeLock`
 *    **不会**释放它——释放它的唯一办法是让视频停下来：`desktop::pet::set_pet_window_visible(false)`
 *    会**销毁**桌宠窗口（而不是 hide），webview 随窗口消失，媒体管线一并停止（见
 *    issue #469 的第二处修复）。`muted` 也不是解药：muted 只影响音频，不解除该锁。
 *
 * 之所以仍然保留本模块：它把「页面主动申请常亮」这条路径彻底封死，避免将来某个
 * 页面（设置页、插件面板）再加一个与桌宠无关的常亮申请；成本只是一次方法替换。
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
