import type { HostContext } from '../types'
import { describe, expect, it } from 'vitest'
import { defineHostRuntime } from './runtime'

function createHost(): HostContext {
  return { sessions: {} } as unknown as HostContext
}

describe('defineHostRuntime', () => {
  it('未绑定时读取直接抛错', () => {
    const { getCurrentHostInstance } = defineHostRuntime()
    expect(() => getCurrentHostInstance()).toThrow(/尚未绑定/)
  })

  it('绑定后取回同一实例，传 undefined 后回到未绑定', () => {
    const { getCurrentHostInstance, setCurrentHostInstance } = defineHostRuntime()
    const host = createHost()

    setCurrentHostInstance(host)
    expect(getCurrentHostInstance()).toBe(host)

    setCurrentHostInstance(undefined)
    expect(() => getCurrentHostInstance()).toThrow(/尚未绑定/)
  })

  it('每个槽位彼此隔离', () => {
    const first = defineHostRuntime()
    const second = defineHostRuntime()
    const host = createHost()

    first.setCurrentHostInstance(host)
    expect(first.getCurrentHostInstance()).toBe(host)
    expect(() => second.getCurrentHostInstance()).toThrow(/尚未绑定/)
  })

  it('支持收窄到插件自有宿主面', () => {
    const runtime = defineHostRuntime<HostContext & { stopSessionProcesses: () => void }>()
    const stopSessionProcesses = () => {}
    runtime.setCurrentHostInstance(Object.assign(createHost(), { stopSessionProcesses }))

    expect(runtime.getCurrentHostInstance().stopSessionProcesses).toBe(stopSessionProcesses)
  })
})
