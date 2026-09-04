import { describe, expect, it } from 'vitest'
import { toTransferable } from './transferable'

describe('toTransferable', () => {
  it('剥离函数、符号、bigint 与 undefined，保留纯 JSON 数据', () => {
    expect(toTransferable({
      id: 's1',
      status: 'running',
      apply: () => undefined,
      count: 0n,
      hidden: undefined,
      [Symbol('tag')]: 'never-kept',
    })).toEqual({ id: 's1', status: 'running' })
  })

  it('递归收敛嵌套数组并过滤不可传输项', () => {
    expect(toTransferable({
      pending: ['a', () => undefined, null, 3, undefined],
    })).toEqual({ pending: ['a', null, 3] })
  })

  it('打破循环引用而不是无限递归', () => {
    const root: Record<string, unknown> = { id: 's1' }
    const child: Record<string, unknown> = { parent: root }
    root.child = child
    const cleaned = toTransferable(root) as Record<string, unknown>
    expect(cleaned.id).toBe('s1')
    expect(cleaned.child).toEqual({})
  })

  it('共享引用各自保留而非互相抹除', () => {
    const shared = { marker: 'x' }
    const cleaned = toTransferable({ a: shared, b: shared })
    expect(cleaned).toEqual({ a: { marker: 'x' }, b: { marker: 'x' } })
  })

  it('date 转 ISO 字符串，Map 转普通对象，Set 转数组', () => {
    const cleaned = toTransferable({
      when: new Date('2024-01-02T03:04:05.000Z'),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
    })
    expect(cleaned).toEqual({
      when: '2024-01-02T03:04:05.000Z',
      map: { k: 'v' },
      set: [1, 2],
    })
  })

  it('class 实例与宿主对象被丢弃（postMessage 无法结构化克隆）', () => {
    class SessionRecord {
      constructor(readonly title: string) {}
    }
    expect(toTransferable({ record: new SessionRecord('t'), ok: true }))
      .toEqual({ ok: true })
  })

  it('原始值与空值原样通过', () => {
    expect(toTransferable('s')).toBe('s')
    expect(toTransferable(7)).toBe(7)
    expect(toTransferable(true)).toBe(true)
    expect(toTransferable(null)).toBeNull()
    expect(toTransferable(undefined)).toBeUndefined()
  })
})
