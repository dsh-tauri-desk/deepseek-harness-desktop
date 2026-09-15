/**
 * register/index.adapter.ts — DSH 客户端升级迁移适配层（`defineRegister` 的第三个参数）。
 *
 * 用法：
 * ```ts
 * const feature = defineRegister((controller, ctx, adapter) => {
 *   // 新建会话：官方服务 → DOM 退级，明确回报走了哪一级
 *   void adapter.startSession()
 *   // 打开文件夹：pickDirectory → create → startSession 全流程
 *   void adapter.addWorkspace({ openSession: true })
 *   // 跨版本同形的会话列表投影
 *   controller.add(adapter.sessions.list!.subscribe(() => sync()))
 *   if (adapter.has('workspaces.create')) { ... }
 * })
 *
 * ctx.effect(feature, 'demo: feature')
 * ```
 *
 * 四条设计约束：
 *
 * 1. **只按能力探测，不比对版本号**——`generation` 仅供诊断与日志，所有分支读服务形态；
 * 2. **迁移是按序执行的注册表**——新增一代 DSH 只需追加一条 `DshMigration`
 *    （`defineAdapter` 的 `migrations` 选项），既有迁移与消费方都不改；
 * 3. **探测绝不抛错**——Cordis 的 inject-only 守卫、半初始化上下文、缺失服务一律当作
 *    「能力不可用」，把退级决定权交回消费方（官方 API → 壳补丁 → DOM 补丁 → 禁用）；
 * 4. **官方服务的方法一律绑定到原对象再外抛**——核心服务是 class 实例，方法被解构后不能丢
 *    `this`，也绝不能让 Proxy 冒充 `this`（内部自调用与私有字段会炸）。
 *
 * 适配层是无状态投影：每次调用返回新实例，不注册监听、不持跨卸载状态，因此不需要 disposer，
 * 也不会与 `ctx.effect` 的清理路径冲突。
 */
import type {
  AdapterAddWorkspaceOptions,
  AdapterAddWorkspaceOutcome,
  AdapterCapability,
  AdapterContext,
  AdapterGeneration,
  AdapterListProjection,
  AdapterMigrationFailure,
  AdapterProbe,
  AdapterRuntimeObject,
  AdapterSessions,
  AdapterStartSessionOutcome,
  AdapterSurface,
  AdapterWorkspaceId,
  AdapterWorkspaces,
  ClientAdapter,
  DefineAdapterOptions,
  DshMigration,
} from '../types/adapter'
import { ADD_WORKSPACE_SELECTOR, NEW_SESSION_SELECTOR } from '../constants'
import { clickIfPresent } from '../utils/browser'

export type * from '../types/adapter'

/** 适配层告警出口（默认 console.warn；宿主可注入以上报到插件面板）。 */
type AdapterWarn = (message: string, error?: unknown) => void

const defaultWarn: AdapterWarn = (message, error) => {
  if (error === undefined)
    console.warn(message)
  else
    console.warn(message, error)
}

/**
 * 守卫安全的服务读取：`ctx.get(name)` 优先（Cordis 对未声明键的 inject-only 守卫会抛错），
 * 回退属性读取；任何异常都等同于「服务不存在」。
 */
function readService(ctx: unknown, name: string): unknown {
  if (ctx === null || ctx === undefined)
    return undefined
  const kind = typeof ctx
  if (kind !== 'object' && kind !== 'function')
    return undefined
  const runtime = ctx as { get?: (name: string) => unknown } & AdapterRuntimeObject
  try {
    return typeof runtime.get === 'function' ? runtime.get(name) : runtime[name]
  }
  catch {
    return undefined
  }
}

/** 把对象的方法绑定到自身。 */
function bindMembers<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

/**
 * 适配一个官方服务：方法绑定到**原对象**（绝不让 Proxy 充当 `this`）；
 * `list` 投影再包一层并缓存（`sessions.list` 的引用稳定性是 uSES 的前提）。
 */
function adaptService<T extends object>(service: T): T {
  const boundLists = new WeakMap<object, object>()
  return new Proxy(service, {
    get(t, prop) {
      const member = Reflect.get(t, prop)
      if (prop === 'list' && member !== null && typeof member === 'object') {
        const cached = boundLists.get(member)
        if (cached !== undefined)
          return cached
        const bound = bindMembers(member as object)
        boundLists.set(member, bound)
        return bound
      }
      return typeof member === 'function' ? member.bind(t) : member
    },
  })
}

/**
 * 跨版本 thenable 判定。
 *
 * legacy 与 modern 的 `startSession` 都返回 void，但投影实现可能返回 Promise：
 * 只 await 真正的 thenable，避免对同步返回值做无意义等待。
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    return false
  return typeof (value as PromiseLike<unknown>).then === 'function'
}

/**
 * legacy 核心不暴露 per-session 的 `provideInfo`：官方能力优先，缺失时用
 * `sessions.binding(id)` + `uiSession.adapter.resolve(id)` 的投影补齐。
 * 补不出也绝不因此让插件失败——这是可选桥，不是必需能力。
 */
function resolveProvideInfo(
  sessions: AdapterRuntimeObject,
  sessionId: string,
  uiSession: AdapterRuntimeObject | undefined,
): unknown {
  // 部分桌面运行时即使在 legacy 布局下也提供了完整投影：原生路径优先。
  const native = sessions.provideInfo
  if (typeof native === 'function') {
    try {
      const value = native.call(sessions, sessionId)
      if (value !== undefined)
        return value
    }
    catch {
      // 新建会话正在物化时可能瞬时抛错：继续走下面的兼容投影。
    }
  }

  const bindingFn = sessions.binding
  if (typeof bindingFn !== 'function' || bindingFn.call(sessions, sessionId) === undefined)
    return undefined

  const adapter = uiSession?.adapter as AdapterRuntimeObject | undefined
  const resolveFn = adapter?.resolve
  if (typeof resolveFn !== 'function')
    return undefined
  try {
    const projected = resolveFn.call(adapter, sessionId) as AdapterRuntimeObject | undefined
    const inputActions = (projected?.props as AdapterRuntimeObject | undefined)?.inputActions
    return inputActions === undefined ? undefined : { props: { inputActions } }
  }
  catch {
    // binding 可能在新会话物化期间消失：按不可用处理。
    return undefined
  }
}

/**
 * 布局世代探测——**只用于诊断与日志**，任何分支都不读它。
 *
 * 世代标记是「`uiWorkspace` 这个独立导航服务是否在场」：`≤0.1.2-rc.1` 线把导航与目录选择
 * 放在它上面，`0.1.5-rc.1` 起统一收进 `ctx.workspaces`。注意 `sessions.list` 嵌不嵌套**不是**
 * 世代信号（两代的 `list` 都带 `getSnapshot` / `subscribe`），它只是能力差异，由迁移自己探测。
 */
function detectGeneration(service: AdapterProbe['service']): AdapterGeneration {
  try {
    if (service('uiWorkspace') !== undefined)
      return 'legacy'
    if (service('sessions') !== undefined || service('workspaces') !== undefined)
      return 'modern'
  }
  catch {
    // 半初始化上下文：世代不明，交回能力探测判断。
  }
  return 'unknown'
}

/** 基线迁移：官方服务方法绑定到原对象（所有布局都跑，越早越好）。 */
const SERVICES_AUTO_BIND_MIGRATION: DshMigration = {
  id: 'services:auto-bind',
  description: '官方 sessions / workspaces 服务方法自动绑定 this',
  detect: () => true,
  apply(surface) {
    if (surface.sessions !== undefined)
      surface.sessions = adaptService(surface.sessions)
    if (surface.workspaces !== undefined)
      surface.workspaces = adaptService(surface.workspaces)
  },
}

/**
 * 把列表投影补到 `sessions` 顶层（老写法读 `ctx.sessions.getSnapshot / subscribe`）。
 *
 * 这是**能力**迁移而非版本迁移：两代核心的投影都挂在 `sessions.list` 上，顶层别名只是让旧式
 * 消费方免改；新版若已在顶层提供同形方法则原样保留。
 */
const SESSIONS_LIST_PROJECTION_MIGRATION: DshMigration = {
  id: 'sessions:list-projection',
  description: 'sessions.list 投影 → sessions.getSnapshot / subscribe 顶层别名',
  detect: (_probe, surface) =>
    surface.sessions?.list !== undefined && typeof surface.sessions.getSnapshot !== 'function',
  apply(surface) {
    const sessions = surface.sessions
    const list = sessions?.list as AdapterListProjection | undefined
    if (sessions === undefined || list === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'list')
          return list
        if (prop === 'getSnapshot')
          return () => list.getSnapshot()
        if (prop === 'subscribe')
          return (listener: () => void) => list.subscribe(listener)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/**
 * legacy 核心不暴露 per-session 的 `provideInfo`：用 `sessions.binding(id)` +
 * `uiSession.adapter.resolve(id)` 的投影补齐（消费方如 worktree 依赖它取 inputActions）。
 *
 * 探测很严：`binding` 与 `uiSession.adapter.resolve` 缺一就不安装桥——宁可在
 * `has('sessions.provideInfo')` 上诚实报 false，也不放一个永远返回 undefined 的函数。
 * 原生 `provideInfo` 在场也照样装桥：它可能只覆盖部分会话，`resolveProvideInfo` 会原生优先、
 * 缺失时回退投影。
 */
const SESSIONS_PROVIDE_INFO_MIGRATION: DshMigration = {
  id: 'sessions:provide-info-bridge',
  description: 'sessions.binding + uiSession.adapter.resolve → sessions.provideInfo 兼容桥',
  detect: (_probe, surface) => {
    if (typeof surface.sessions?.binding !== 'function')
      return false
    const adapter = surface.uiSession?.adapter as AdapterRuntimeObject | undefined
    return typeof adapter?.resolve === 'function'
  },
  apply(surface) {
    const sessions = surface.sessions
    if (sessions === undefined)
      return
    surface.sessions = new Proxy(sessions as object, {
      get(target, prop) {
        if (prop === 'provideInfo')
          return (sessionId: string) => resolveProvideInfo(target as AdapterRuntimeObject, sessionId, surface.uiSession)
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterSessions
  },
}

/**
 * legacy：`workspaces` 自身没有导航方法，由独立的 `uiWorkspace` 服务提供。
 * 只有 `uiWorkspace` 真的提供该能力时才覆盖；它缺席时回退 `workspaces` 原生实现。
 */
const LEGACY_WORKSPACES_MIGRATION: DshMigration = {
  id: 'legacy:workspaces-navigation',
  description: 'uiWorkspace.startSession / connectWorkspace → workspaces 导航投影',
  detect: (_probe, surface) => {
    const owner = surface.uiWorkspace
    if (owner === undefined)
      return false
    return typeof owner.startSession === 'function' || typeof owner.connectWorkspace === 'function'
  },
  apply(surface) {
    const workspaces = surface.workspaces
    const owner = surface.uiWorkspace
    if (workspaces === undefined || owner === undefined)
      return
    surface.workspaces = new Proxy(workspaces as object, {
      get(target, prop) {
        if (prop === 'startSession' || prop === 'connectWorkspace') {
          const fn = owner[prop]
          if (typeof fn === 'function')
            return (...args: unknown[]) => fn.call(owner, ...args)
          const fallback = Reflect.get(target, prop)
          return typeof fallback === 'function' ? fallback.bind(target) : fallback
        }
        const member = Reflect.get(target, prop)
        return typeof member === 'function' ? member.bind(target) : member
      },
    }) as AdapterWorkspaces
  },
}

/** 跨布局：把「新建会话」收敛成 `surface.startSession`（`uiWorkspace` 优先，`workspaces` 兜底）。 */
const NAVIGATION_MIGRATION: DshMigration = {
  id: 'navigation:resolve-start-session',
  description: 'uiWorkspace.startSession ?? workspaces.startSession → surface.startSession',
  detect: () => true,
  apply(surface) {
    // 逐个候选服务找「真的实现了 startSession」的那一个：只按服务在场判断会让
    // 半迁移宿主（uiWorkspace 只提供 pickDirectory）静默吞掉 workspaces 的原生导航。
    for (const owner of [surface.uiWorkspace, surface.workspaces]) {
      const fn = owner?.startSession
      if (owner !== undefined && typeof fn === 'function') {
        surface.startSession = (workspaceId?: AdapterWorkspaceId) => fn.call(owner, workspaceId)
        return
      }
    }
  },
}

/**
 * 跨布局：「打开文件夹」三段能力聚合。
 *
 * 目录选择在 legacy 是 `uiWorkspace.pickDirectory`、modern 是 `workspaces.pickDirectory`；
 * 建工作区一直是 `workspaces.create`；开新会话复用上一条迁移解析出的 `surface.startSession`。
 * 三段缺一即视为不可用，由消费方退级到点官方按钮。
 */
const WORKSPACE_ADD_MIGRATION: DshMigration = {
  id: 'workspace:resolve-add-workspace',
  description: 'pickDirectory + workspaces.create + startSession → surface.addWorkspace',
  detect: () => true,
  apply(surface) {
    const workspaces = surface.workspaces
    const startSession = surface.startSession
    // 目录选择的宿主服务随版本迁移（详见文件头）：modern 在 workspaces 上，legacy 在 uiWorkspace 上。
    const pickOwner = typeof workspaces?.pickDirectory === 'function' ? workspaces : surface.uiWorkspace
    const pickDirectory = pickOwner?.pickDirectory
    const create = workspaces?.create
    if (
      typeof pickDirectory !== 'function'
      || typeof create !== 'function'
      || startSession === undefined
      || pickOwner === undefined
    ) {
      return
    }
    surface.addWorkspace = {
      pickDirectory: () => pickDirectory.call(pickOwner) as Promise<string | null | undefined>,
      createWorkspace: input => create.call(workspaces, input),
      startSession: workspaceId => startSession(workspaceId),
    }
  },
}

/**
 * 内置迁移（按序执行，后一条能看到前一条的投影）：
 * 1. 基线自动绑定 → 2. 会话列表投影别名 → 3. legacy `provideInfo` 兼容桥 →
 * 4. legacy 工作区导航投影 → 5. 跨布局导航解析 → 6. 跨布局「打开文件夹」解析。
 * 消费方可用 `defineAdapter(ctx, { migrations })` 追加，追加项在最后执行。
 */
export const DEFAULT_DSH_MIGRATIONS: readonly DshMigration[] = [
  SERVICES_AUTO_BIND_MIGRATION,
  SESSIONS_LIST_PROJECTION_MIGRATION,
  SESSIONS_PROVIDE_INFO_MIGRATION,
  LEGACY_WORKSPACES_MIGRATION,
  NAVIGATION_MIGRATION,
  WORKSPACE_ADD_MIGRATION,
]

/**
 * 迁移后的上下文投影：`sessions` / `workspaces` 换成适配后的服务面，其余成员原样透传；
 * 读取失败按 undefined（不把 Cordis 的 inject 守卫抛给消费方）。
 */
function createAdapterContext(
  ctx: unknown,
  sessions: AdapterSessions,
  workspaces: AdapterWorkspaces,
): AdapterContext {
  const kind = typeof ctx
  const base = (ctx !== null && (kind === 'object' || kind === 'function') ? ctx : {}) as AdapterRuntimeObject
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'sessions')
        return sessions
      if (prop === 'workspaces')
        return workspaces
      try {
        return Reflect.get(target, prop, receiver)
      }
      catch {
        return undefined
      }
    },
  }) as AdapterContext
}

/** 新建会话：官方导航 → 点官方按钮 → 明确回报不可用（绝不静默半工作）。 */
async function runStartSession(
  surface: AdapterSurface,
  workspaceId: AdapterWorkspaceId | undefined,
  warn: AdapterWarn,
): Promise<AdapterStartSessionOutcome> {
  const start = surface.startSession
  if (start !== undefined) {
    const value = start(workspaceId)
    // 异步实现回报解析后的结果（而不是把 pending Promise 当 value 外抛）。
    return { status: 'started', value: isThenable(value) ? await value : value }
  }
  if (clickIfPresent(NEW_SESSION_SELECTOR))
    return { status: 'delegated' }
  const reason = 'no workspace navigation service and no official new-session button'
  warn(`[dsh-adapter] startSession unavailable: ${reason}`)
  return { status: 'unavailable', reason }
}

/** 打开文件夹：官方三段能力全流程 → 点官方按钮 → 明确回报不可用；目录选择器取消是正常结果。 */
async function runAddWorkspace(
  surface: AdapterSurface,
  options: AdapterAddWorkspaceOptions | undefined,
  warn: AdapterWarn,
): Promise<AdapterAddWorkspaceOutcome> {
  const runtime = surface.addWorkspace
  if (runtime === undefined) {
    if (clickIfPresent(ADD_WORKSPACE_SELECTOR))
      return { status: 'delegated' }
    const reason = 'no pickDirectory/create/startSession capability and no official add-workspace button'
    warn(`[dsh-adapter] addWorkspace unavailable: ${reason}`)
    return { status: 'unavailable', reason }
  }

  const path = await runtime.pickDirectory()
  // 用户在原生目录选择器里取消：正常结果，不是失败。
  if (path === null || path === undefined)
    return { status: 'cancelled' }

  const workspace = await runtime.createWorkspace({ path })
  const openSession = options?.openSession ?? true
  if (openSession) {
    const value = runtime.startSession(workspace.workspaceId)
    if (isThenable(value))
      await value
  }
  return { status: 'created', workspaceId: workspace.workspaceId, path, sessionStarted: openSession }
}

/**
 * 创建 DSH 升级迁移适配实例（`defineRegister` 的第三个参数就由它产生）。
 *
 * 探测与迁移全程不抛错：单条迁移失败只记入 `failures` 并告警，插件装配照常继续——
 * 一条投影失败不该让整个插件不可用，但也不能悄悄吞掉。
 *
 * @param ctx - 客户端上下文（可为 `undefined`：`defineRegister(setup)()` 直接调用时没有 ctx）。
 * @param options - 追加迁移与告警出口。
 * @returns 无状态适配实例（不注册监听，无需 disposer）。
 */
export function defineAdapter(ctx: unknown, options: DefineAdapterOptions = {}): ClientAdapter {
  const warn = options.onWarn ?? defaultWarn
  const service = <T = AdapterRuntimeObject>(name: string): T | undefined =>
    readService(ctx, name) as T | undefined

  const probe: AdapterProbe = { generation: detectGeneration(service), service }
  const surface: AdapterSurface = {
    sessions: service<AdapterSessions>('sessions') ?? {},
    workspaces: service<AdapterWorkspaces>('workspaces') ?? {},
    uiWorkspace: service<AdapterRuntimeObject>('uiWorkspace'),
    uiSession: service<AdapterRuntimeObject>('uiSession'),
  }

  const migrations: string[] = []
  const failures: AdapterMigrationFailure[] = []
  for (const migration of [...DEFAULT_DSH_MIGRATIONS, ...(options.migrations ?? [])]) {
    try {
      if (!migration.detect(probe, surface))
        continue
      migration.apply(surface, probe)
      migrations.push(migration.id)
    }
    catch (error) {
      failures.push({ migration: migration.id, error })
      warn(`[dsh-adapter] migration "${migration.id}" failed; projection kept as-is`, error)
    }
  }

  const sessions = surface.sessions ?? {}
  const workspaces = surface.workspaces ?? {}

  // 用 Record 而非 switch 表达穷尽性：新增能力时编译期就会报缺少检查项。
  const capabilityChecks: Record<AdapterCapability, () => boolean> = {
    'sessions.list': () => typeof sessions.list?.getSnapshot === 'function',
    'sessions.provideInfo': () => typeof sessions.provideInfo === 'function',
    'workspaces.list': () => typeof workspaces.list?.getSnapshot === 'function',
    'workspaces.create': () => typeof workspaces.create === 'function',
    'navigation.startSession': () => surface.startSession !== undefined,
    'navigation.addWorkspace': () => surface.addWorkspace !== undefined,
    'dom.newSession': () => typeof document !== 'undefined' && document.querySelector(NEW_SESSION_SELECTOR) !== null,
    'dom.addWorkspace': () => typeof document !== 'undefined' && document.querySelector(ADD_WORKSPACE_SELECTOR) !== null,
  }

  return {
    generation: probe.generation,
    migrations,
    failures,
    ctx: createAdapterContext(ctx, sessions, workspaces),
    sessions,
    workspaces,
    service,
    has: capability => capabilityChecks[capability](),
    resolveStartSession: () => surface.startSession,
    resolveAddWorkspace: () => surface.addWorkspace,
    startSession: workspaceId => runStartSession(surface, workspaceId, warn),
    addWorkspace: callOptions => runAddWorkspace(surface, callOptions, warn),
  }
}
