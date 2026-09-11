import { defineConfig } from 'vitest/config'

/**
 * 根测试配置：运行内置插件（packages/**）、插件管理及壳层状态机/入口契约回归测试，
 * 限制并发 worker 数与放宽超时。
 *
 * 仓库根还 vendored 了 dsh 核心源码（source/ 与 test/ 下的部分用例），其测试依赖
 * dsh 核心的 `@/` paths 解析（在插件 workspace 的 vitest 下不可用），故 exclude 出
 * 本范围；壳层自身的用例按文件显式列入 include。
 *
 * dsh-tauri-worktree 的 operation.test 会创建真实 git 仓库（clone/checkout/
 * discard），全量并行（默认 cpu-1 个 worker）时与其他文件的 git 操作竞争系统
 * 资源，偶发 5s 超时 flake；限制 maxWorkers 后单独复跑稳定通过。
 */
export default defineConfig({
  test: {
    include: [
      'packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
      'test/toast.test.ts',
      // issue #469：桌面端不得持有屏幕唤醒锁（桌宠 <video> 会间接加锁，导致无法息屏）。
      'test/disable-wake-lock.test.ts',
      // issue #469：收起桌宠必须是销毁窗口（隐藏窗口里的视频仍在播放并持锁）。
      'test/pet-window-lifecycle.test.ts',
      'test/plugin-batch.test.ts'
    ],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
