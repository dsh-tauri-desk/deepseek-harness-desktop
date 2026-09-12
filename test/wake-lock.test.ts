// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 屏幕唤醒锁契约（issue #469）。
 *
 * 主窗口与桌宠窗口都没有「屏幕常亮」的正当需求：桌宠动画是常驻播放的 `<video>`，
 * Chromium 会因此持有 Video Wake Lock 让系统无法息屏。壳层改用 reause
 * `useWakeLock()` 观察唤醒锁状态，一旦有锁生效立刻 `release()`。
 *
 * 原先的 `navigator.wakeLock.request` 猴补丁（`utils/disable-wake-lock.ts`）已删除，
 * 这里把「两个窗口入口都释放唤醒锁」的不变量锁在源码层面：任一入口漏掉即失败。
 */
const WAKE_LOCK_ENTRIES = [
  '../src/layout/index.tsx',
  '../src/pet/app.tsx',
]

describe('wake lock contract', () => {
  it('releases any active wake lock in both window entries', () => {
    for (const path of WAKE_LOCK_ENTRIES) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(source).toContain('useWakeLock()')
      expect(source).toContain('useWatch(wakelock.isActive')
      expect(source).toContain('wakelock.release()')
    }
  })

  it('no longer patches navigator.wakeLock anywhere in the shell', () => {
    const entries = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    const petEntry = readFileSync(new URL('../src/pet/main.tsx', import.meta.url), 'utf8')

    for (const source of [entries, petEntry]) {
      expect(source).not.toContain('disableWakeLock')
    }
  })

  it('keeps every pet animation video muted', () => {
    // 视频层已整体交给 dsh-pet-component（src/pet 不再自带 <video>）：断言渲染器的
    // 双缓冲视频都显式静音 —— 桌宠动画一旦出声就是回归（与 #469 同源的常驻播放契约）。
    const bundle = readFileSync(
      new URL('../node_modules/dsh-pet-component/dist/index.mjs', import.meta.url),
      'utf8',
    )
    const muted = bundle.match(/muted:\s*true/g) ?? []
    expect(muted.length).toBeGreaterThanOrEqual(2)
  })
})
