/**
 * 把会话快照递归收敛为可跨窗口传输的纯 JSON 数据，供 postMessage / Tauri invoke
 * 序列化：剔除函数/符号/bigint/undefined 与 class 实例（postMessage 结构化克隆
 * 会抛 DataCloneError，Rust 侧也要求 serde_json 可序列化），seen 集合打破循环引用。
 */
export function toTransferable(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined)
    return value
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint')
    return undefined
  if (type !== 'object')
    return value
  if (seen.has(value))
    return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value
      .map(item => toTransferable(item, seen))
      .filter(item => item !== undefined)
    seen.delete(value)
    return result
  }
  if (value instanceof Date)
    return value.toISOString()
  if (value instanceof Map) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of value) {
      const cleanKey = toTransferable(key, seen)
      const cleanItem = toTransferable(item, seen)
      if (typeof cleanKey === 'string' && cleanItem !== undefined)
        result[cleanKey] = cleanItem
    }
    seen.delete(value)
    return result
  }
  if (value instanceof Set) {
    const result = [...value]
      .map(item => toTransferable(item, seen))
      .filter(item => item !== undefined)
    seen.delete(value)
    return result
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    seen.delete(value)
    return undefined
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const cleanItem = toTransferable((value as Record<string, unknown>)[key], seen)
    if (cleanItem !== undefined)
      result[key] = cleanItem
  }
  seen.delete(value)
  return result
}
