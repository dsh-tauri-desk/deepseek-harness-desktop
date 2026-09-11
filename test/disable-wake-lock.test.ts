// @vitest-environment node
import type { Mock } from 'vitest'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disableWakeLock, restoreWakeLock } from '../src/utils/disable-wake-lock'

/**
 * 原生 `navigator.wakeLock.request` 的替身：默认放行并返回一个哨兵对象，
 * `acquire` 记录调用次数，用来证明「禁用后页面再也拿不到唤醒锁」而不是只看抛不抛错。
 */
function createWakeLockStub() {
  const request = vi.fn((type: WakeLockType) => Promise.resolve({ type, release: vi.fn() })) as Mock<WakeLock['request']>
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    // 赋值断言：Node 环境没有原生 WakeLock 实现，这里用替身顶上
    value: { request },
    writable: true,
  })
  return request
}

function removeWakeLock() {
  Reflect.deleteProperty(navigator, 'wakeLock')
}

describe('disableWakeLock', () => {
  beforeEach(() => {
    removeWakeLock()
  })

  afterEach(() => {
    restoreWakeLock()
    removeWakeLock()
  })

  it('rejects every screen wake lock request so the screen can sleep again', async () => {
    const native = createWakeLockStub()
    disableWakeLock()

    await expect(navigator.wakeLock.request('screen')).rejects.toThrow('WAKELOCK_DISABLED')
    // 关键回归点：不只是抛错，原生的加锁入口必须一次都没被走到。
    expect(native).not.toHaveBeenCalled()
  })

  it('rejects system wake lock requests as well', async () => {
    const native = createWakeLockStub()
    disableWakeLock()

    await expect(navigator.wakeLock.request('system')).rejects.toThrow('WAKELOCK_DISABLED')
    expect(native).not.toHaveBeenCalled()
  })

  it('leaves the sentinel released state unreachable (no lock is ever handed out)', async () => {
    createWakeLockStub()
    disableWakeLock()

    const acquired = await navigator.wakeLock.request('screen').catch((error: unknown) => error)
    expect(acquired).toBeInstanceOf(Error)
    // 唤醒锁不该以「返回了对象」的形式静默生效；页面拿到的只能是 Error。
    expect(acquired).not.toHaveProperty('release')
  })

  it('is idempotent across both entry points and never chains its own override', async () => {
    const native = createWakeLockStub()
    disableWakeLock()
    const patched = navigator.wakeLock.request
    disableWakeLock()

    expect(navigator.wakeLock.request).toBe(patched)
    restoreWakeLock()
    // 恢复后必须能真正加锁：重复调用若把替换实现记成「原函数」，这里就会永远 reject。
    await expect(navigator.wakeLock.request('screen')).resolves.toBeDefined()
    expect(native).toHaveBeenCalledOnce()
  })

  it('is a no-op when the environment has no Wake Lock API', () => {
    expect(() => disableWakeLock()).not.toThrow()
    expect(() => restoreWakeLock()).not.toThrow()
  })
})

describe('pet window wake lock contract', () => {
  /**
   * 桌宠窗口是常驻播放的 WebView：只要动画 `<video>` 没被禁用唤醒锁，系统就无法息屏
   * （issue #469）。这里锁死两个入口都调用了 disableWakeLock，避免将来只改一个入口。
   */
  it('disables the wake lock in both window entries', () => {
    const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    const petSource = readFileSync(new URL('../src/pet/main.tsx', import.meta.url), 'utf8')

    expect(mainSource).toContain('disableWakeLock()')
    expect(petSource).toContain('disableWakeLock()')
  })

  it('keeps every pet animation video muted', () => {
    const source = readFileSync(new URL('../src/pet/components/pet.tsx', import.meta.url), 'utf8')
    const videos = source.match(/<video[\s\S]*?\/>/g) ?? []

    // 双 video 缓冲（前台/后台）各一个；两个都不能出声，否则桌宠动画会突然发声。
    expect(videos).toHaveLength(2)
    for (const video of videos)
      expect(video).toMatch(/\bmuted\b/)
  })
})
