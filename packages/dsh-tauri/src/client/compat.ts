import type { ClientContext } from './types'

type RuntimeObject = Record<string, unknown>
export type StartSession = (workspaceId?: string) => unknown

/** Read a service without triggering Cordis' inject-only property guard. */
function lookup(ctx: ClientContext, name: string): unknown {
  const anyCtx = ctx as unknown as { get?: (name: string) => unknown } & RuntimeObject
  try {
    return typeof anyCtx.get === 'function' ? anyCtx.get(name) : anyCtx[name]
  }
  catch {
    return undefined
  }
}

/** Resolve the navigation method across Alpha and rc.2 service layouts. */
export function resolveStartSession(ctx: ClientContext): StartSession | undefined {
  const uiWorkspace = lookup(ctx, 'uiWorkspace') as RuntimeObject | undefined
  const workspaces = lookup(ctx, 'workspaces') as RuntimeObject | undefined
  const owner = uiWorkspace ?? workspaces
  const fn = owner?.startSession
  return typeof fn === 'function' ? (workspaceId?: string) => fn.call(owner, workspaceId) : undefined
}

/** Adapt alpha's nested list/navigation services to the rc.2 plugin contract. */
export function compat(ctx: ClientContext): ClientContext {
  const safeLookup = (name: string): unknown => lookup(ctx, name)

  // Inline Alpha Detection: 判断当前环境是否为 Alpha 版本
  const alphaSessions = safeLookup('sessions') as RuntimeObject | undefined
  const isAlpha
    = (alphaSessions?.list !== undefined && typeof alphaSessions.getSnapshot !== 'function')
      || safeLookup('uiWorkspace') !== undefined

  if (!isAlpha)
    return ctx

  // 补全当前环境的对象引用
  const rawSessions = (alphaSessions ?? {}) as RuntimeObject
  const rawWorkspaces = (safeLookup('workspaces') ?? {}) as RuntimeObject
  const uiWorkspace = safeLookup('uiWorkspace') as RuntimeObject | undefined
  const uiSession = safeLookup('uiSession') as RuntimeObject | undefined

  // Inline Auto-Bind Proxy: 为 snapshot 绑定 Proxy 实例
  const createBoundProxy = (target: unknown): RuntimeObject | undefined => {
    if (!target || (typeof target !== 'object' && typeof target !== 'function'))
      return undefined
    return new Proxy(target as object, {
      get(t, p, r) {
        const member = Reflect.get(t, p, r)
        return typeof member === 'function' ? member.bind(t) : member
      },
    }) as RuntimeObject
  }

  const list = createBoundProxy(rawSessions.list)
  const workspaceList = createBoundProxy(rawWorkspaces.list)

  // 映射 sessions 适配层
  const sessions = new Proxy(rawSessions as object, {
    get(target, prop, receiver) {
      if (prop === 'list')
        return list
      if (prop === 'getSnapshot')
        return () => (list?.getSnapshot as (() => unknown) | undefined)?.()
      if (prop === 'subscribe')
        return (l: () => void) => (list?.subscribe as ((cb: () => void) => unknown) | undefined)?.(l)
      if (prop === 'provideInfo')
        return (id: string) => provideInfo(rawSessions, id, uiSession)
      const member = Reflect.get(target, prop, receiver)
      return typeof member === 'function' ? member.bind(target) : member
    },
  }) as unknown as RuntimeObject

  // 映射 workspaces 适配层
  const workspaces = new Proxy(rawWorkspaces as object, {
    get(target, prop, receiver) {
      if (prop === 'list')
        return workspaceList
      if (prop === 'startSession') {
        // rc.2 官方运行时的 workspaces 自身已提供 startSession；旧 alpha 才经由
        // 独立的 uiWorkspace 服务暴露。优先 uiWorkspace，缺失时回退到 rawWorkspaces，
        // 避免按钮点击被静默吞掉。
        const owner = uiWorkspace ?? rawWorkspaces
        const fn = owner.startSession
        return typeof fn === 'function' ? (id?: string) => fn.call(owner, id) : undefined
      }
      if (prop === 'connectWorkspace') {
        const owner = uiWorkspace ?? rawWorkspaces
        const fn = owner.connectWorkspace
        return typeof fn === 'function' ? (id: string) => fn.call(owner, id) : undefined
      }

      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as RuntimeObject

  // 返回最终的上下文代理对象
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'sessions')
        return sessions
      if (prop === 'workspaces')
        return workspaces
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Alpha deliberately does not expose the old per-session info lookup. Try
 * documented scope/provide implementations when a shell supplies one, but
 * never make a plugin fail merely because that optional bridge is absent.
 */
function provideInfo(sessions: RuntimeObject, id: string, uiSession: RuntimeObject | undefined): unknown {
  // Some desktop runtimes expose the complete per-session projection on the
  // sessions service even though their list shape still looks like Alpha.
  // Preserve that native path first; the adapter fallback below is only for
  // runtimes that genuinely lack sessions.provideInfo().
  const nativeProvideInfo = sessions.provideInfo
  if (typeof nativeProvideInfo === 'function') {
    try {
      return nativeProvideInfo.call(sessions, id)
    }
    catch {
      // The session may still be materializing; try the compatibility path.
    }
  }
  const bindingFn = sessions.binding
  const binding = typeof bindingFn === 'function' ? bindingFn.call(sessions, id) : undefined
  if (!binding)
    return undefined

  const adapter = uiSession?.adapter as RuntimeObject | undefined
  const resolveFn = adapter?.resolve

  if (typeof resolveFn === 'function') {
    try {
      const projected = resolveFn.call(adapter, id) as RuntimeObject | undefined
      const inputActions = (projected?.props as RuntimeObject | undefined)?.inputActions
      if (inputActions !== undefined) {
        return { props: { inputActions } }
      }
    }
    catch {
      // The binding can disappear while a newly-created session is materialized.
    }
  }
  return undefined
}
