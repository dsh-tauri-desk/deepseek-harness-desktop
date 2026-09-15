/**
 * client/utils/context.ts — 从 effect 回调里取回客户端上下文。
 *
 * cordis 4 的 `ctx.effect(callback)` 以 `callback.call(fiber)` 调用：`this` 是 **Fiber**
 * 而不是 ctx，服务面（locale / slots / sessions…）只在 `fiber.ctx` 上。dsh-tauri 的
 * `defineRegister` / `defineLocale` 契约把 ctx 经 `this` 传入，统一在这里归一化：
 * 是 Fiber 就取 `this.ctx`，其余情况认为 `this` 已经是 ctx。
 */
export function effectContext<T>(self: unknown): T | undefined {
  if (self === null || typeof self !== 'object')
    return undefined
  return Object.hasOwn(self, 'ctx') ? (self as { ctx: T }).ctx : (self as T)
}
