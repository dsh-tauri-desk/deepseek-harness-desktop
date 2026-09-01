/**
 * utils/width.test.ts — 宽度纯函数单测（resolveContentWidth / readWidthPreference /
 * clampWidth 的契约与边界）。
 */

import type { WidthPreferenceStorage } from './width'
import { describe, expect, it } from 'vitest'
import { PANEL_WIDTH_PREF_KEY } from '../constants'
import { clampWidth, readWidthPreference, resolveContentWidth, writeWidthPreference } from './width'

/** 内存存储替身（每次调用独立，避免跨用例污染）。 */
function makeStorage(initial?: Record<string, string>): WidthPreferenceStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

describe('readWidthPreference', () => {
  it('解析已持久化的数字偏好', () => {
    const storage = makeStorage({ [PANEL_WIDTH_PREF_KEY]: '720' })
    expect(readWidthPreference(storage)).toBe(720)
  })

  it('未设置时返回 null', () => {
    expect(readWidthPreference(makeStorage())).toBeNull()
  })

  it('损坏 / 非法值返回 null（不抛错，按无偏好处理）', () => {
    for (const raw of ['abc', '0', '-5', 'NaN', 'Infinity', ''])
      expect(readWidthPreference(makeStorage({ [PANEL_WIDTH_PREF_KEY]: raw }))).toBeNull()
  })
})

describe('writeWidthPreference', () => {
  it('写入整数 px', () => {
    const storage = makeStorage()
    writeWidthPreference(storage, 720.6)
    expect(storage.getItem(PANEL_WIDTH_PREF_KEY)).toBe('721')
  })
})

describe('clampWidth', () => {
  it('clamp 进闭区间', () => {
    expect(clampWidth(500, 640, 1024)).toBe(640)
    expect(clampWidth(800, 640, 1024)).toBe(800)
    expect(clampWidth(2000, 640, 1024)).toBe(1024)
    expect(clampWidth(640, 640, 1024)).toBe(640)
    expect(clampWidth(1024, 640, 1024)).toBe(1024)
  })
})

describe('resolveContentWidth', () => {
  it('有偏好：clamp 进 [CONTENT_MIN, column - EDGE_BUDGET]', () => {
    // 列宽 1200 → 上界 1200-176=1024
    expect(resolveContentWidth(1200, 640)).toBe(640)
    expect(resolveContentWidth(1200, 800)).toBe(800)
    expect(resolveContentWidth(1200, 1024)).toBe(1024)
    expect(resolveContentWidth(1200, 3000)).toBe(1024)
    expect(resolveContentWidth(1200, 100)).toBe(640)
  })

  it('有偏好但列窄：上界至少是 CONTENT_MIN', () => {
    // 列宽 800 → 上界 max(640, 800-176=624)=640，任何偏好都被夹到 640
    expect(resolveContentWidth(800, 700)).toBe(640)
    expect(resolveContentWidth(800, 900)).toBe(640)
  })

  it('无偏好：自适应 clamp(680px, col*0.64, 920px)', () => {
    expect(resolveContentWidth(1200, null)).toBe(768) // 1200*.64=768
    expect(resolveContentWidth(600, null)).toBe(680) // 600*.64=384 → 抬到下限 680
    expect(resolveContentWidth(2000, null)).toBe(920) // 2000*.64=1280 → 压到上限 920
    expect(resolveContentWidth(0, null)).toBe(680)
  })
})
