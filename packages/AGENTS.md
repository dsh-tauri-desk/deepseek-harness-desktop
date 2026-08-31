# AGENTS.md

## 项目概览

DeepSeek Harness 的 Tauri 插件 workspace，采用 host half / client half 架构。

- `packages/*/src/*.ts`：宿主侧服务实现。
- `packages/*/src/index.ts`：宿主侧能力、工具、HTTP 路由和系统上下文。
- `packages/*/src/types.ts`：宿主侧类型定义。
- `packages/*/src/constants.ts`：宿主侧常量定义。
- `packages/*/src/client/*.ts`：浏览器侧插件、slot 组件和 DOM 集成。
- `packages/*/src/client/types.ts`：该插件客户端共享类型的唯一集中位置。
- `packages/*/src/client/constants.ts`：该插件客户端共享常量的唯一集中位置。
- `packages/*/src/client/icons.ts`：该插件客户端共享图标的唯一集中位置，图标只从 github.com/gravity-ui/icons 中获取。
- `packages/*/src/client/styles.ts`：该插件客户端 css-render 样式树和样式挂载函数。

## 基本技术约定

- 使用 TypeScript，保持 strict 类型检查。
- 使用 ESM，所有包保留 `"type": "module"`。
- 使用 pnpm；依赖版本优先通过 `pnpm-workspace.yaml` 的命名 catalog 管理。
- 使用 `@antfu/eslint-config`，不引入 Prettier。
- 提交前运行 `pnpm run lint --fix`，不要新增独立的 `lint:fix` script。
- 完成非平凡改动后必须运行 lint、typecheck、test 和相关 build。
- 优先使用相对路径导入；只有仓库已经配置并使用的别名才能继续使用。
- 类型和常量必须显式导入，避免隐式或自动导入。
- React 组件文件统一使用全小写 kebab-case（`xx-xx.tsx`），例如 `extension-panel.tsx`、`markdown-preview.tsx`；不得使用 PascalCase 文件名。
- 函数尽量声明明确返回类型；复杂 inline 类型应提取为命名类型。
- 注释解释设计原因，不重复描述代码表面行为。

## 客户端类型集中规则

每个插件的客户端共享类型统一放在该插件的 `src/client/types.ts`：

```ts
// src/client/types.ts
export interface SettingsSidebarProps {
  // ...
}

export type SelectorHook<T> = <S>(selector: (state: T) => S) => S
```

组件、服务和工具文件不得重复声明跨文件使用的 `interface` 或 `type`。使用 type-only import：

```ts
import type { SelectorHook, SettingsSidebarProps } from './types'
```

仅在为了兼容既有公开 API 时，才允许从原文件 re-export 类型：

```ts
export type { NavBridgeHandlers } from './types'
```

纯组件内部且绝不跨文件使用的极小类型可以保留在组件文件中，但新增类型默认应先考虑放入 `types.ts`。

## 客户端常量集中规则

每个插件的客户端共享常量统一放在该插件的 `src/client/constants.ts`：

- slot 名称、注册 id、registrant、order 和 priority
- CSS style id、class name、CSS custom property 名称
- API prefix、storage key、事件 source/type、命令名称
- 动画时长、尺寸边界、默认值和正则表达式
- locale namespace 和稳定协议标识

示例：

```ts
// src/client/constants.ts
export const PANEL_PROTOCOL_SERVICE = 'panel.protocol'
export const PANEL_ACTION_SLOT = 'sidebar.panel.action'
export const PANEL_STYLE_ID = 'dsh-tauri-panel-styles'
```

组件文件只消费常量，不重复写共享字符串或数字。真正只使用一次且不表达协议的局部值可以保留在实现文件中。

## 样式与 css-render 规则

所有客户端自定义样式使用 [`css-render`](https://css-render.vercel.app/)：

- 不使用 React 静态 inline styles。
- 不使用 `style.textContent`、手写 `<style>` 注入或 `raw` CSS 字符串绕过 css-render 对象树。
- CSS 规则拆成 `CssRender().c(selector, properties, children)` 节点。
- css-render 样式只允许在插件 `apply()` 生命周期中挂载。
- 样式挂载函数命名为 `mount<Name>Styles`，返回 `() => void` disposer。
- 样式安装和卸载必须由 `ctx.effect()` 管理。
- 如果 style id 已由其他生命周期挂载，当前调用不得取得其所有权，也不得在 disposer 中卸载它。
- hover、focus、active、disabled 等状态优先使用 CSS selector 或 modifier class。
- 仅保留真正动态的几何值作为 CSS custom property，例如拖拽宽度。
- 所有动态样式必须可在插件卸载时恢复，不得在 React render 中挂载全局样式。
- style id 和 class name 使用插件前缀，跨插件协议使用的 class 名称必须保持兼容。

标准模式：

```ts
export function mountPanelStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}

  const cssr = CssRender()
  if (cssr.find(PANEL_STYLE_ID) !== null)
    return () => {}

  const style = cssr.c([
    cssr.c('.dshp-panel', {
      display: 'flex',
    }),
  ])
  style.mount({ id: PANEL_STYLE_ID, head: true })
  return () => style.unmount({ id: PANEL_STYLE_ID })
}
```

## 客户端 apply 与生命周期规则

每个客户端插件的 `apply()` 应按以下顺序组织：

1. 注册或安装 locale、运行时状态和协议服务。
2. 通过 `ctx.effect()` 挂载 css-render 样式，并返回 disposer。
3. 注册 slot 组件和 UI 行为。
4. 通过 `ctx.effect()` 管理 MutationObserver、事件监听、定时器、hydration 和 DOM 补丁。

命名按职责区分：

- `mount*Styles`：挂载 css-render 样式并返回 disposer。
- `install*`：安装 locale、服务、observer、hydration 等运行时能力。
- `register*`：注册 slot、组件或协议条目。
- `apply`：插件唯一的总装配入口。

每个 effect 必须拥有对应清理逻辑：

- 取消 MutationObserver。
- 移除 event listener。
- 清理 timeout、interval 和未执行的 animation frame。
- 取消或忽略过期异步请求。
- 卸载当前实例实际拥有的样式。
- 恢复被临时修改的宿主 DOM 状态。

## Slot 与组件协议规则

slot 注册必须保持稳定且可追踪：

```ts
ctx.slots.register(
  {
    name: SLOT_NAME,
    id: COMPONENT_ID,
    registrant: PLUGIN_NAME,
    order: COMPONENT_ORDER,
    priority: COMPONENT_PRIORITY,
    inject: sessionId => ({ sessionId }),
  },
  Component,
)
```

- `name`、`id`、`registrant` 使用 `constants.ts` 中的稳定常量。
- props 结构在 `types.ts` 中定义，不在多个组件间复制。
- 组件协议的 public props 必须有可访问名称和明确类型。
- 缺少可选 renderer patch 时必须 graceful fallback，不得白屏。
- 不得依赖生成的 CSS module hash；优先使用稳定 slot、ARIA 属性和插件前缀 class。
- 跨插件协议的 class、slot、service key 修改时必须同步更新所有消费者和文档。

## 宿主侧规则

- Git、文件系统、进程和宿主 API 只能放在 host half。
- HTTP route 必须严格限制方法；变更操作必须校验来源、参数和 session 归属。
- 破坏性 Git 操作必须检查每一步结果，失败时保留可恢复 binding/ledger。
- 不得用 `process.cwd()` 作为未知 session 的静默 fallback。
- ledger 和 checkout context 使用原子写入；load-modify-save 需要考虑并发更新。
- 不得静默覆盖用户已有分支或未提交改动。
- 用户输入的 branch/ref 必须使用 Git 权威校验，不要仅依赖自制正则。

## 退级策略

当功能需要当前官方 dsh 发行版未提供的宿主能力时，按从最优到最差的顺序规划**退级阶梯**：

1. **官方公开 API** —— `ctx.sessions`、`ctx.workspaceRegistry`、`ctx.sessionPersistence`、`ctx.agents`、`ctx.webServer`、`ctx.tools`、`ctx.systemPrompt`，客户端 `ctx.slots` / `ctx.sessions` / `ctx.workspaces`。务必对照**已安装** dsh 版本的 `.d.ts` 核实签名，绝不臆断 API 存在。
2. **桌面壳补丁** —— 官方 API 缺失时，桌面壳（桌面应用外壳）在启动前对捆绑的 dsh 核心做补丁（见 `src-tauri/src/service/workflow/*_patch.rs` 模式），以锚点校验、幂等、带单元测试的方式暴露窄面补充能力（例如 `SessionStore.remove(id)`）。插件侧做能力探测，缺失时报错。
2. **DOM 补丁** —— 客户端半区可通过 MutationObserver + capture 监听改写官方 DOM（portal 菜单、侧边栏行），使用稳定的 `aria-label` / `role` 选择器，绝不用生成的 CSS module 哈希。
3. **功能禁用 / 降级模式** —— 以上都不适用时禁用功能并输出明确日志，绝不静默半工作。

## 测试与验证

- Vitest 测试使用 `describe` / `it` / `expect`，禁止恒真占位测试。
- `foo.ts` 的测试命名为同目录 `foo.test.ts`。
- 优先测试纯函数、状态转换、HTTP 方法/授权边界、storage 原子性和公开协议。
- UI 测试应验证 fallback、slot 注册、ARIA 状态和卸载清理。
- 完成改动后运行：

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run test -- --run
pnpm run build
```

## 交付检查清单

- [ ] 新增共享类型已放入对应 `src/client/types.ts`。
- [ ] 新增共享常量已放入对应 `src/client/constants.ts`。
- [ ] 样式全部由 css-render 对象节点生成。
- [ ] 样式只在 `apply()` 的 effect 中挂载。
- [ ] 样式 disposer、observer、listener、timer 均已清理。
- [ ] slot 协议使用稳定 id、registrant 和显式 props 类型。
- [ ] 没有静默覆盖用户数据或 Git 分支。
- [ ] lint、typecheck、test、build 均通过。
- [ ] 相关 README、协议文档和导出契约已同步。
