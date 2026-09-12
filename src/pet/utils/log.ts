import { invoke } from '@tauri-apps/api/core'

/**
 * 把桌宠窗口的异常转发到应用日志（`logs/desktop.log`）。
 *
 * 桌宠窗口是独立 webview，默认没有任何日志出口：它的 console 只有在手动 F12 时才可见，
 * 出问题时只能靠猜（「窗口是空的」既可能是没选宠物、也可能是资源没拉下来）。
 * 这里统一走壳层的 `log_frontend` 命令，把异常落进主日志，便于事后定位。
 *
 * 失败静默：日志本身绝不能再抛错（命令不存在时应只是没有日志，而不是让桌宠窗口崩掉）。
 */
export function reportPetIssue(scope: string, detail: unknown): void {
  const message = `[pet] ${scope}: ${formatDetail(detail)}`
  console.warn(message)
  void invoke('log_frontend', {
    level: 'error',
    target: 'pet',
    message: message.slice(0, 4000),
  }).catch(() => {})
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error)
    return `${detail.name}: ${detail.message}`
  if (typeof detail === 'string')
    return detail
  try {
    return JSON.stringify(detail)
  }
  catch {
    return String(detail)
  }
}
