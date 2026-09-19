/**
 * 单元测试的 Tauri 运行时垫片（`unit` project 的 setupFile）。
 *
 * 壳层有模块在**导入期**就访问 Tauri API——`config/storage.ts` 加载 store、
 * `setting/store.ts` 订阅事件——而 node 环境没有 `window`，导入即抛
 * `ReferenceError: window is not defined`，文件连收集都过不去，表现为
 * 「Vitest caught N unhandled errors」并把整轮判为失败（测试本身却全绿）。
 *
 * 这里按 Tauri 官方测试姿势（`@tauri-apps/api/mocks`）补一个最小运行时：
 * IPC 一律 resolve `undefined`，窗口标签固定 `main`。真正需要后端行为的地方，
 * 仍由各用例自行 `vi.mock`。
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

interface MinimalWindow {
  __TAURI_INTERNALS__?: Record<string, unknown>
  __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
  addEventListener: () => void
  removeEventListener: () => void
  dispatchEvent: () => boolean
  location: { href: string }
  /** `@tauri-apps/api/mocks` 的 transformCallback 用它生成随机 id。 */
  crypto: Crypto
}

// 断言成不含 DOM 的窄形状：DOM lib 把 `window` 声明为完整 `Window`，
// 直接交叉会要求补全 Location 等全部成员，而这里只补运行时真正会被读到的那几个。
const globals = globalThis as unknown as { window?: MinimalWindow }

// 只补缺失的浏览器表面，不覆盖已有实现（将来换 jsdom 环境时自然让位）。
globals.window ??= {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  location: { href: 'http://localhost/' },
  crypto: globalThis.crypto,
}

mockIPC(() => undefined)
mockWindows('main')
