import { postRestart } from '../apis'
import { isDesktopHost } from './restart.utils'

export async function restartHost(): Promise<{ ok: boolean, error?: string }> {
  if (isDesktopHost()) {
    window.dshDesktop?.restartSidecar?.()
    return { ok: true }
  }
  try {
    await postRestart()
  }
  catch {
  }
  return { ok: true }
}
