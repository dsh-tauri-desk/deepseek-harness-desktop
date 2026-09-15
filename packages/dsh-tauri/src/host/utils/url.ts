/**
 * host/utils/url.ts — 宿主侧 URL 校验工具。
 *
 * 插件路由把用户/外部输入交给系统打开（`openUrl`）之前必须先收敛协议：
 * 只放行 http/https，其余（file: / javascript: / 自定义 scheme）一律拒绝。
 * 校验失败返回 null 而不是抛错，调用方据此回 400——绝不静默放行。
 */
export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  }
  catch {
    return null
  }
}
