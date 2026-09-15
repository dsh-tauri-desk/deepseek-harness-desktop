/**
 * client/service/capabilities.test.ts — 「打开文件」与「审核」的内核能力判据。
 *
 * 守两条需求硬约束：**旧内核必须静默**（它同样派发 `openFile`，但会把路径交给
 * 宿主/系统去打开）；**旧内核不显示「审核」按钮**（连 `sidebarRightTabs` 都没有）。
 * 判据都是能力探测，不是版本号。
 *
 * 探测改成纯函数 `readCapabilities(ctx)` 后，上下文由调用方传入，
 * 因此不再有安装/卸载与模块级引用可测；相应的用例改成「同一读数随上下文变化」。
 */

import type { ClientContext } from 'dsh-tauri/client'
import { describe, expect, it } from 'vitest'
import { readCapabilities } from './capabilities'

/** 最小上下文替身：只提供能力探测真正读到的 `reflect.get`。 */
function contextWith(service: unknown, options: { throws?: boolean } = {}): ClientContext {
  return {
    reflect: {
      get: () => {
        if (options.throws === true)
          throw new Error('registry unavailable')
        return service
      },
      provide: () => () => {},
    },
  } as unknown as ClientContext
}

/** 按**服务名**返回不同替身的上下文（能力探测会读多个键）。 */
function contextWithServices(services: Record<string, unknown>): ClientContext {
  return {
    reflect: {
      get: (name: string) => services[name],
      provide: () => () => {},
    },
  } as unknown as ClientContext
}

describe('readCapabilities / sidebarPreview', () => {
  it('上下文里没有 sidebarRight 服务时按「没有该能力」处理（绝不误开外部程序）', () => {
    expect(readCapabilities(contextWith(undefined)).sidebarPreview).toBe(false)
  })

  it('新内核：reflect 里有 sidebarRight 服务 → 可用', () => {
    expect(readCapabilities(contextWith({ openResource: () => {} })).sidebarPreview).toBe(true)
  })

  it('旧内核：没有 sidebarRight 服务 → 不可用（静默）', () => {
    // 旧内核的 reflect 里没有这个键，get 返回 undefined。
    expect(readCapabilities(contextWith(undefined)).sidebarPreview).toBe(false)
  })

  it('注册表读取抛错时按不可用处理，不冒泡', () => {
    expect(readCapabilities(contextWith(undefined, { throws: true })).sidebarPreview).toBe(false)
  })

  it('缺少 reflect 的壳也不会崩', () => {
    expect(readCapabilities({} as unknown as ClientContext).sidebarPreview).toBe(false)
  })

  it('每次都按当前 reflect 读数探测：服务消失后回到不可用（不缓存旧引用）', () => {
    let service: unknown = { openResource: () => {} }
    const ctx = {
      reflect: {
        get: () => service,
        provide: () => () => {},
      },
    } as unknown as ClientContext
    expect(readCapabilities(ctx).sidebarPreview).toBe(true)
    service = undefined
    expect(readCapabilities(ctx).sidebarPreview).toBe(false)
  })

  it('探测结果只取决于传入的上下文：两个上下文互不影响（没有模块级共享状态）', () => {
    const withService = contextWith({ openResource: () => {} })
    const withoutService = contextWith(undefined)
    expect(readCapabilities(withService).sidebarPreview).toBe(true)
    expect(readCapabilities(withoutService).sidebarPreview).toBe(false)
    expect(readCapabilities(withService).sidebarPreview).toBe(true)
  })
})

describe('readCapabilities / sidebar / fileTree', () => {
  /** 新内核：控制器与页类型注册表都在，注册表认得 `files`。 */
  function newKernelContext(): ClientContext {
    return contextWithServices({
      sidebarRight: { openTab: () => {} },
      sidebarRightTabs: { get: (kind: string) => (kind === 'files' ? { kind: 'files' } : undefined) },
    })
  }

  it('新内核：注册表里有 files 页类型 → 「审核」可用', () => {
    const caps = readCapabilities(newKernelContext())
    expect(caps.fileTree).toBe(true)
    expect(caps.sidebar).toBeDefined()
    expect(typeof caps.sidebar?.openTab).toBe('function')
  })

  it('旧内核：reflect 里只有别的服务 → 文件树缺席（按钮不显示）', () => {
    expect(readCapabilities(contextWithServices({ sidebarRight: { openResource: () => {} } })).fileTree).toBe(false)
  })

  it('注册表在、但没有 files 页类型 → 不显示按钮（避免点下去抛 no tab type）', () => {
    expect(readCapabilities(contextWithServices({ sidebarRightTabs: { get: () => undefined } })).fileTree).toBe(false)
  })

  it('注册表形状不符 / get 抛错 / 缺 reflect → 一律按不可用处理，不冒泡', () => {
    expect(readCapabilities(contextWithServices({ sidebarRightTabs: {} })).fileTree).toBe(false)

    expect(readCapabilities(contextWithServices({
      sidebarRightTabs: {
        get: () => {
          throw new Error('registry unavailable')
        },
      },
    })).fileTree).toBe(false)

    const bare = readCapabilities({} as unknown as ClientContext)
    expect(bare.fileTree).toBe(false)
    expect(bare.sidebar).toBeUndefined()
  })

  it('服务注册为 null 时按缺席处理（不返回一个空壳控制器）', () => {
    expect(readCapabilities(contextWithServices({ sidebarRight: null })).sidebar).toBeUndefined()
  })
})
