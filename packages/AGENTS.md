# AGENTS.md

## 项目概览

DeepSeek Harness 的 Tauri 插件 workspace，两半端（host half / client half）架构。
每个插件的源码按「运行时边界 → 业务领域」组织为三层：

```
packages/<plugin>/
├─ src/
│  ├─ index.ts                 # 公开 barrel：只保留导出面（name/inject/apply/领域能力 re-export）
│  ├─ shared/                  # 跨 host/client 的稳定协议常量
│  │  └─ constants.ts          # 插件名 / API 前缀 / 分区顺序（两端共同引用，防硬编码漂移）
│  ├─ host/                    # Node half：宿主能力、工具、HTTP 路由、系统上下文
│  │  ├─ apply.ts              # 插件装配入口（apply）
│  │  ├─ constants/            # 宿主侧私有常量（index.ts barrel，多领域再拆文件）
│  │  ├─ types/                # 宿主侧类型（index.ts barrel，多领域再拆文件）
│  │  ├─ hooks/                # hookable 生命周期钩子（index.ts barrel，有事件轴时才建）
│  │  ├─ routes/               # HTTP 路由（index.ts barrel；多路由再拆 routes/*.ts）
│  │  ├─ storage/              # 持久化 / 状态（index.ts barrel）
│  │  ├─ service/              # 领域服务单文件（git / operation / session / archive / agents / mcp …）
│  │  └─ tools/                # 宿主工具能力（index.ts barrel，多能力再拆 tools/*.ts）
│  └─ client/                  # Browser half：插件、slot 组件、DOM 集成
│     ├─ index.ts              # 客户端 barrel + apply 装配
│     ├─ constants/            # 客户端共享常量（index.ts barrel，多领域再拆文件）
│     ├─ types/                # 客户端共享类型（index.ts barrel，多领域再拆文件）
│     ├─ locales/              # 双语字典 + installLocale（index.ts barrel）
│     ├─ apis/                 # ofetch 客户端（client.ts 绑定 API 前缀；index.ts barrel 聚合）
│     ├─ styles/               # css-render 样式树（index.ts barrel，多主题再拆文件）
│     ├─ components/           # 纯 UI 组件 + 共享图标（每组件一文件：icons.tsx / dialog.tsx …）
│     ├─ register/             # 安装器 / 槽位注册（install*/register*，与组件分离）
│     ├─ store/                # 共享状态（index.ts barrel，多领域再拆文件）
│     ├─ config/               # 客户端配置 / 初始化状态（index.ts barrel）
│     ├─ service/              # 客户端领域逻辑 / 控制器（handoff.ts / actions.ts / menu.ts …）
│     ├─ utils/                # 纯函数：解析/格式化/归一化（editable.ts / sort.ts / clipboard.ts …）
│     ├─ hooks/                # React hooks（跨组件逻辑、轮询、提交拦截）
│     └─ dom/                  # DOM 补丁 / 定位（MutationObserver + capture + 稳定选择器）
└─ tsconfig.json               # 每包都有：extends ../../tsconfig.json + include src/** 与 ../../types/**/*.d.ts
```

目录规律：**单一职责文件 → 同名目录（index.ts barrel 聚合）**。`constants.ts`→`constants/index.ts`、
`types.ts`→`types/index.ts`、`locale.ts`→`locales/index.ts`、`rpc.ts`→`apis/client.ts`+`apis/index.ts`、
`styles.ts`→`styles/index.ts`、`store.ts`→`store/index.ts`、`lib/`→`utils/`、`features/`→`components/`、
`state.ts`（client）→`config/index.ts`、安装器→`register/`、宿主领域单文件→`service/`、
`state.ts`/`storage.ts`（host）→`storage/index.ts`、`route.ts`/`routes.ts`→`routes/index.ts`、
`tools.ts`→`tools/index.ts`、`hooks.ts`→`hooks/index.ts`。

依赖方向单向：`shared ← host/client`；`host` 与 `client` 互不导入；`shared` 不导入任何实现。
`src/index.ts` 只做组合与 re-export，不放状态、监听、初始化或路由 handler。

## 依赖策略（UnJS + 客户端收敛）

依赖版本统一经 `pnpm-workspace.yaml` 的命名 catalog（`utils`）管理：`pathe` / `hookable` / `ofetch` / `unstorage`。

- **宿主侧直接引用包**：host 代码用什么就声明为当前包的 `dependencies`（运行时按该插件 node_modules 解析）：
  - `pathe`：宿主全部路径处理，**不用 `node:path`**（git/storage/operation/route 等）。
  - `hookable`：宿主钩子轴（host/hooks/）。
  - `ofetch`：宿主二进制下载（如 GitHub tarball 走 `$fetch.raw`）。
- **客户端依赖统一由 `dsh-tauri` 承载**：`unstorage` / `hookable` / `ofetch` 只被 `dsh-tauri` 的 client bundle 加载并内联；**其他插件 client 禁止直接 import 这三个包**，一律从 `dsh-tauri/client` 导入：
  - `createHooks`（hookable 命名钩子）
  - `createLocalStorage(base)`（unstorage localStorage driver；`base` 传插件名、不带冒号，driver 拼 `base:` 前缀防串扰）
  - `requestJson` / `createJsonClient`（ofetch 统一 JSON 客户端）
  - `createLifecycleController`（生命周期控制器）
  - `createAtomicFsStorage(base)` 从 `dsh-tauri` 根导入（宿主侧 unstorage fs + tmp+rename 原子写）。
- 后果：`dsh-tauri` 的 client bundle 是唯一内联三库的地方；其他插件 client 走外部 `dsh-tauri/client`，不重复内联。
- 纯 client 插件（dsh-tauri-panel / rightclick / ui 等）通常只需 `dsh-tauri` 一个依赖。

## 基本技术约定

- 使用 TypeScript，保持 strict 类型检查；每包自带 `tsconfig.json`，`pnpm --filter <pkg> typecheck` 必须真实生效。
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

每个插件的客户端共享类型统一放在该插件的 `src/client/types/`（`types/index.ts` 作 barrel 聚合，多领域拆 `types/<domain>.ts`）：

```ts
// src/client/types/index.ts
export interface SettingsSidebarProps {
  // ...
}

export type SelectorHook<T> = <S>(selector: (state: T) => S) => S
```

组件、服务和工具文件不得重复声明跨文件使用的 `interface` 或 `type`。使用 type-only import：

```ts
import type { SelectorHook, SettingsSidebarProps } from '../types'
```

仅在为了兼容既有公开 API 时，才允许从原文件 re-export 类型：

```ts
export type { NavBridgeHandlers } from '../types'
```

纯组件内部且绝不跨文件使用的极小类型可以保留在组件文件中，但新增类型默认应先考虑放入 `types/`。

## 客户端常量集中规则

每个插件的客户端共享常量统一放在该插件的 `src/client/constants/`（`constants/index.ts` 作 barrel 聚合，多领域拆 `constants/<domain>.ts`）：

- slot 名称、注册 id、registrant、order 和 priority
- CSS style id、class name、CSS custom property 名称
- API prefix、storage key、事件 source/type、命令名称
- 动画时长、尺寸边界、默认值和正则表达式
- locale namespace 和稳定协议标识

示例：

```ts
// src/client/constants/index.ts
export const PANEL_PROTOCOL_SERVICE = 'panel.protocol'
export const PANEL_ACTION_SLOT = 'sidebar.panel.action'
export const PANEL_STYLE_ID = 'dsh-tauri-panel-styles'
```

组件文件只消费常量，不重复写共享字符串或数字。真正只使用一次且不表达协议的局部值可以保留在实现文件中。
跨 half 共享的协议常量（插件名 / API 前缀 / 分区顺序）放 `src/shared/constants.ts`，host/constants/ 与 client/constants/ 从那里 re-export，不再各自硬编码。

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
3. 通过 `ctx.effect()` 注册 slot 组件（inject 句柄随之释放）与 UI 行为。
4. 通过 `ctx.effect()` 管理 hydration、DOM 补丁和生命周期控制器。

命名按职责区分：

- `mount*Styles`：挂载 css-render 样式并返回 disposer。
- `install*`：安装 locale、服务、observer、hydration 等运行时能力。
- `register*`：注册 slot、组件或协议条目（经 `ctx.effect(() => register*(ctx))` 包装，卸载即释放 inject）。
- `apply`：插件唯一的总装配入口。

**生命周期控制器（Controller 化）**：需要同时管理 observer / timer / listener / 订阅时，使用 `dsh-tauri/client` 的 `createLifecycleController()`：

- `add(disposer)` / `timeout(fn, ms)` / `interval(fn, ms)` / `listen(type, fn, options)` / `observe(target, options, onMutate)` 统一登记。
- `dispose()` 幂等，一次性清理全部资源；`isDisposed()` 用于异步续接守护，业务代码不再各自维护 `disposed` 标志。
- `dispose` 本身是命名钩子（hookable），保留扩展点。

宿主侧若存在真实事件/状态机轴，建 `host/hooks/`（hookable 命名钩子），事件在业务状态**落定后**触发（如归档 `archive:added`、provider `provider:after-remount`、会话 `session:turn-end`）；钩子实例在 apply 内创建或作为插件级单例导出。

每个 effect / 控制器必须拥有对应清理逻辑：

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

- `name`、`id`、`registrant` 使用 `constants/` 中的稳定常量。
- props 结构在 `types/` 中定义，不在多个组件间复制。
- 组件协议的 public props 必须有可访问名称和明确类型。
- 缺少可选 renderer patch 时必须 graceful fallback，不得白屏。
- 不得依赖生成的 CSS module hash；优先使用稳定 slot、ARIA 属性和插件前缀 class。
- 跨插件协议的 class、slot、service key 修改时必须同步更新所有消费者和文档。
- renderer 补丁追加的导出（如 `@deepseek-ai/dsh-client-ui-renderer` 的 `SlotOutlet`）由仓库根 `types/slot-outlet.d.ts` 提供 ambient 类型；消费方必须先 `typeof SlotOutlet === 'function'` 探测再使用。

## 宿主侧规则

- Git、文件系统、进程和宿主 API 只能放在 host half。
- HTTP route 必须严格限制方法；变更操作必须校验来源、参数和 session 归属。
- 破坏性 Git 操作必须检查每一步结果，失败时保留可恢复 binding/ledger。
- 不得用 `process.cwd()` 作为未知 session 的静默 fallback。
- ledger 和 checkout context 使用原子写入；load-modify-save 需要考虑并发更新。
- 涉及注册表的多写点变更（如工作区记账 + 归档集合）必须在同一个串行事务（`enqueueOperation`）内完成。
- 不得静默覆盖用户已有分支或未提交改动。
- 用户输入的 branch/ref 必须使用 Git 权威校验，不要仅依赖自制正则。

## 构建与部署约定

- 每个包经 `dsh-tauri-tsdown` 的 `defineDshConfig()` 构建：host entry = `src/index.ts`，client entry = `src/client/index.ts`（CJS + ModuleLoader factory）。
- client bundle 必须把 `unstorage` / `hookable` / `ofetch` / `pathe` 内联（`noExternal`，见 dsh-tauri-tsdown），否则 loader 模块表找不到会报 "missed the module table"；host bundle 保持 external（运行时按依赖解析）。
- 桌面端通过 `pnpm build`（prebuild 部署插件到 `src-tauri/resources`）消费各包 dist；不要提交 dist 与部署产物（已被 gitignore）。

## 退级策略

当功能需要当前官方 dsh 发行版未提供的宿主能力时，按从最优到最差的顺序规划**退级阶梯**：

1. **官方公开 API** —— `ctx.sessions`、`ctx.workspaceRegistry`、`ctx.sessionPersistence`、`ctx.agents`、`ctx.webServer`、`ctx.tools`、`ctx.systemPrompt`，客户端 `ctx.slots` / `ctx.sessions` / `ctx.workspaces`。务必对照**已安装** dsh 版本的 `.d.ts` 核实签名，绝不臆断 API 存在。
2. **桌面壳补丁** —— 官方 API 缺失时，桌面壳（桌面应用外壳）在启动前对捆绑的 dsh 核心做补丁（见 `src-tauri/src/service/workflow/*_patch.rs` 模式），以锚点校验、幂等、带单元测试的方式暴露窄面补充能力（例如 `SessionStore.remove(id)`）。插件侧做能力探测，缺失时报错。
3. **DOM 补丁** —— 客户端半区可通过 MutationObserver + capture 监听改写官方 DOM（portal 菜单、侧边栏行），使用稳定的 `aria-label` / `role` 选择器，绝不用生成的 CSS module 哈希。
4. **功能禁用 / 降级模式** —— 以上都不适用时禁用功能并输出明确日志，绝不静默半工作。

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

- [ ] 新增共享类型已放入对应 `src/client/types/`（宿主类型放 `src/host/types/`）。
- [ ] 新增共享常量已放入对应 `src/client/constants/`（跨 half 协议常量放 `src/shared/constants.ts`）。
- [ ] 客户端新增依赖一律经 `dsh-tauri/client` 导入，未直接 import `unstorage` / `hookable` / `ofetch`。
- [ ] 宿主路径处理使用 `pathe`，未新增 `node:path` 用法。
- [ ] 样式全部由 css-render 对象节点生成。
- [ ] 样式只在 `apply()` 的 effect 中挂载。
- [ ] 样式 disposer、observer、listener、timer 均已清理（优先经 `createLifecycleController` 收敛）。
- [ ] slot 协议使用稳定 id、registrant 和显式 props 类型。
- [ ] 没有静默覆盖用户数据或 Git 分支。
- [ ] lint、typecheck、test、build 均通过（含各包 `pnpm --filter <pkg> typecheck` 与根 `pnpm build` 部署）。
- [ ] 相关 README、协议文档和导出契约已同步。
