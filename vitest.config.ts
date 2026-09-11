import { defineConfig } from 'vitest/config'

/**
 * 根测试配置：运行内置插件（packages/**）、插件管理及 toast 生命周期回归测试，限制并发 worker 数与放宽超时。
 *
 * 仓库根还 vendored 了 dsh 核心源码（src/、source/、test/），其测试依赖 dsh 核心
 * 的 `@/` paths 解析（在插件 workspace 的 vitest 下不可用），故 exclude 出本范围。
 *
 * dsh-tauri-worktree 的 operation.test 会创建真实 git 仓库（clone/checkout/
 * discard），全量并行（默认 cpu-1 个 worker）时与其他文件的 git 操作竞争系统
 * 资源，偶发 5s 超时 flake；限制 maxWorkers 后单独复跑稳定通过。
 */
export default defineConfig({
  test: {
    include: ['packages/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}', 'test/toast.test.ts', 'test/plugin-batch.test.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
