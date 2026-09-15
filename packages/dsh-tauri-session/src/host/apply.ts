import type { HostContext } from 'dsh-tauri'
import type { SessionHost } from './config/runtime.types'
import { SESSION_PLUGIN_NAME } from '../shared/constants'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { routes } from './routes'

export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx as unknown as SessionHost)

  ctx.effect(() => routes(ctx), `${SESSION_PLUGIN_NAME}: routes`)
  ctx.effect(() => () => clearHostRuntime(), `${SESSION_PLUGIN_NAME}: host runtime`)
}
