import type { HostContext } from './types'
import { HOST_RUNTIME_EFFECT, ROUTES_EFFECT } from './config/constants'
import { clearHostRuntime, setCurrentHostInstance } from './config/runtime'
import { routes } from './routes'

export function apply(ctx: HostContext): void {
  setCurrentHostInstance(ctx)

  ctx.effect(() => routes(ctx), ROUTES_EFFECT)

  ctx.effect(() => () => clearHostRuntime(), HOST_RUNTIME_EFFECT)
}
