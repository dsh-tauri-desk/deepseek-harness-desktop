/**
 * client/locale/index.ts — 内置插件共用的本地化契约。
 *
 * 一个包只声明一次：命名空间 + 双语词典 → `NS` / `text` / `useLocale` / `registerLocale`。
 * 活跃语言是唯一可变事实，收敛在底座的单例 store（跨插件同一实例），插件不再各自
 * 持有模块级 `let activeLocale`、自建 revision store 或手抄 `Translate` 类型面。
 *
 * ```ts
 * // locales/index.ts
 * export const locale = defineLocale(PLUGIN_NAME, { zh: {...}, en: {...} })
 * export const { NS } = locale
 *
 * // index.ts（二选一，副作用都必须由 controller / effect 托管）
 * ctx.effect(locale.registerLocale, LOCALE_EFFECT)
 * ```
 */

import type { LocaleDict, LocaleService, Translate } from '../types/harness'
import { defineStore, useStore } from '../modules/valtio-define'
import { effectContext } from '../utils/context'

/** 双语词典声明：键集合以 `zh` 为权威，`en` 必须等键集（缺键/多键都是编译错误）。 */
export interface LocaleDicts<D extends LocaleDict = LocaleDict> {
  zh: D
  en: Record<keyof D & string, string>
}

/** 安装所需的最小上下文面（`ctx.effect(registerLocale)` 时由 `this` 提供）。 */
export interface LocaleHost {
  locale: LocaleService
}

/** `defineLocale` 的返回值：声明期即可拿到的全部消费面。 */
export interface LocaleDefinition<NS extends string = string, K extends string = string> {
  /** 命名空间常量（= 插件名）：槽位注册的 `locale:` 与运行时 `bind` 都用它。 */
  NS: NS
  /** 非 React 同步取文案；已安装时走运行时（含 common 兜底），未安装时读本地词典。 */
  text: Translate<K>
  /** 当前活跃语言 id（不订阅，仅同步读取）。 */
  activeLocale: () => string
  /** 当前是否英文界面（格式化函数用，避免各包重复判断）。 */
  isEnglishLocale: () => boolean
  /** React 订阅：活跃语言变化时重渲染（返回当前语言 id）。 */
  useLocale: () => string
  /**
   * 安装：注册双语词典并把快照变更桥接进共享 store。返回幂等 disposer。
   * 可作 effect 交给 `ctx.effect(registerLocale, LABEL)`（运行时经 `effectContext`
   * 从 effect 的 `this` 取回 ctx），也可 `controller.add(registerLocale(ctx))` 显式传 ctx。
   */
  registerLocale: (this: unknown, ctx?: LocaleHost) => () => void
}

/** 未安装时的兜底语言：与核心 `FALLBACK_LOCALE` 一致。 */
const FALLBACK_LOCALE = 'en'

/** 跨插件共享的 locale 桥：活跃语言是唯一可变事实（SSOT 在 store）。 */
const localeBridge = defineStore({
  state: () => ({ active: FALLBACK_LOCALE }),
  actions: {
    sync(active: string) {
      if (this.active !== active)
        this.active = active
    },
  },
})

/** 当前活跃语言 id（`ctx.locale` 快照的同步镜像，由 `registerLocale` 推进）。 */
export function activeLocale(): string {
  return localeBridge.$state.active
}

/** 当前是否英文界面。 */
export function isEnglishLocale(): boolean {
  return activeLocale().toLowerCase().startsWith('en')
}

/** React 组件订阅活跃语言（切换即重渲染）。 */
export function useLocale(): string {
  return useStore(localeBridge).active
}

/** 按 `{name}` 占位符插值；缺值的占位符原样保留（与运行时语义一致）。 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

/**
 * 声明一个插件的本地化契约。
 *
 * @param namespace - 命名空间（= 插件名），槽位注册的 `locale:` 与 `bind` 都用它。
 * @param dicts - `{ zh, en }` 双语词典；`zh` 的键集合是权威，`en` 缺键即编译错误。
 * @returns 契约面：`NS` / `text` / `useLocale` / `registerLocale` 等。
 */
export function defineLocale<const NS extends string, const D extends LocaleDict>(
  namespace: NS,
  dicts: LocaleDicts<D>,
): LocaleDefinition<NS, keyof D & string> {
  type K = keyof D & string

  const zh: LocaleDict = dicts.zh
  const en: LocaleDict = dicts.en
  let live: Translate | undefined
  let installations = 0

  function text(key: K, params?: Record<string, unknown>): string {
    const translate = live
    if (translate !== undefined)
      return translate(key, params)
    const template = (activeLocale() === 'en' ? en[key] : zh[key]) ?? en[key] ?? key
    return interpolate(template, params)
  }

  function registerLocale(this: unknown, ctx?: LocaleHost): () => void {
    const locale = (ctx ?? effectContext<LocaleHost>(this))?.locale
    if (locale === undefined)
      throw new TypeError('defineLocale: 缺少客户端上下文（用 ctx.effect(registerLocale, LABEL) 或 registerLocale(ctx)）')

    const bound = locale.bind?.(namespace)
    if (bound !== undefined)
      live = bound
    installations += 1

    const sync = (): void => localeBridge.sync(locale.getLocale().active)
    // 上游 register 只有「已声明命名空间的 typed 双参」与「单语言三参」两种形态；
    // 插件命名空间是运行期字符串，走三参 untyped 形态逐语言登记。
    const unregisterZh = locale.register(namespace, 'zh', zh)
    const unregisterEn = locale.register(namespace, 'en', en)
    sync()
    const unsubscribe = locale.subscribe(sync)

    let disposed = false
    return () => {
      if (disposed)
        return
      disposed = true
      unsubscribe()
      unregisterZh()
      unregisterEn()
      installations -= 1
      if (installations === 0 && live === bound)
        live = undefined
    }
  }

  return {
    NS: namespace,
    text,
    activeLocale,
    isEnglishLocale,
    useLocale,
    registerLocale,
  }
}
