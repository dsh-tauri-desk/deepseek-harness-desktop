# Development Specification Document

DeepSeek Harness desktop (Tauri 2 + React 19), embeds the Harness UI served at `http://127.0.0.1:3080`.

- **端口隔离**：release 默认 `3080`，debug（`pnpm tauri dev` / `cargo build`）默认 `3081`，由 `config::setting::default_port()` 用 `cfg!(debug_assertions)` 区分，避免开发时与已运行的桌面端争用端口。
- **数据隔离（核心共用、数据不共用）**：node/`dependencies/dsh`/`dependencies/pnpm` 为共用核心（AppData）；debug 构建的 `$DSH_HOME` 默认为 `~/.dsh.dev`（`config::runtime::get_dsh_data_path` 用 `cfg!(debug_assertions)` 区分）且 store 用独立文件 `.store.dev.dat`（`config::setting::store_dat_file_name`），避免开发版与生产版会话/档案/端口状态互相污染，也防止 dev 版热重启把 release 的服务进程杀掉（`service/workflow::terminate_stale_harness_processes` 在 debug 下为 no-op，改由 `.dsh.dev/.harness.pid` 精确回收）。debug 构建不迁移旧数据（`service/migrate`）、不注册/注销 PATH、不写烘焙 DSH_HOME 的 `dsh` shim（`service/cli`）。
- **Windows 极简模式**：预装插件流程（`service/plugin`）对 Windows 用户列出「修复」项（`dsh-win-terminal-inspector`，黄色 chip 默认勾选），确认后 `dsh plugin add github:clearkurt/dsh-win-terminal-inspector` 从 GitHub 安装（桌面端**不内置**插件源码）；随后 `service/workflow/win_inspector.rs`（仅 Windows，幂等）写入 profile `cordis.patch.yml` 挂载行并创作 `$DSH_HOME/.agent-presets/minimal-win/` 用户 preset（Git Bash + danger-full-access，因为 agent preset 组成不受 profile patch 管辖）。
- **内置插件 host 依赖边界**：`packages/*/src/host/` 运行在独立的 `resources/node_modules` 中，禁止直接静态引用任何 `@deepseek-ai/*` 运行时包（包括 `import`、`export ... from` 和 `require`）；必须通过宿主上下文的 `loader.import()` 解析 DSH-owned 模块，并按需处理 `loader.unwrapExports()` 的导出形状。`@deepseek-ai/*` 仅可作为 host 的 type-only import，不能产生运行时依赖。
- **桌宠（`src/pet` + `dsh-tauri-pet`）**：渲染整体交给 `dsh-pet-component` 的 `<Pet>`（外部 npm 包，内部用 `@reause/core`），本仓库只保留设置状态（`src/pet/hooks`）、会话气泡聚合、原生窗口拖拽（`src/hooks/use-window-draggable`）与命中穿透（`src/hooks/use-omit-ignore-cursor-events`），提示 UI 为 `src/ui/pet/hint.tsx` 的 `<Hint>`。预设宠物**不下载不安装**——`src-tauri/resources/preset-pets.json` 只登记远端素材地址与渲染参数（`config` / `uri` / `ext` / `kind` / `size`），pet 窗口直连远端播放并落 IndexedDB 缓存；`src/pet/main.tsx` 把全局 `fetch` 换成 `@tauri-apps/plugin-http` 的实现（其余命令与媒体元素不变），绕开 githubusercontent 的 CORS。macOS 用清单里 `uri.mac` / `ext.mac` 的 HEVC-alpha `.mov`（WKWebView 不认 VP9-alpha）。

- Prioritize using customized components from src/components, hero-ui.
- This will help minimize the need for writing custom classes.
- If you write new content, you need to handle i18n en keys
- i18n keys must be flat (no nesting), use dot-notation flat keys only
- No hardcoded strings; sync i18n locale files (`src/i18n/locales/en-US.json` / `zh-CN.json`)
- If the component you write/modify is too complex, you need to split it into multiple components
- Repeated logic should be encapsulated into methods/components

## Tech Stack

- **Frontend**: React 19 + TS + Tailwind 4 (no plain CSS), Vite (`src/`)
- **Backend**: Rust / Tauri 2 (`src-tauri/src/`)
  - `bridge/cmd.rs`: Tauri commands (register in `lib.rs` `generate_handler!`)
  - `config/`: constants, paths (`runtime.rs`), settings (`setting.rs`), i18n & theme
  - `service/download/`: Node/Dsh/pnpm download & extract (`Installable` trait)
  - `service/workflow/`: process lifecycle (Windows no-window: `win_spawn.rs`)
  - `service/cli/`: `dsh`/`pnpm` shims + PATH registration (`mod.rs`/`shim.rs`/`path.rs`/`core.rs`)
  - `service/scheduler/` + `task/`: health check & polling

## Dev Commands

```bash
pnpm install && pnpm dev    # frontend dev
pnpm typecheck              # frontend TS check (must run after frontend changes)
pnpm tauri dev              # full desktop debug
cargo check && cargo test   # Rust check & unit tests (run in src-tauri)
```

## Basics

- No `useCallback` / `useMemo` — `react-compiler` 已通过 Vite 接入（`babel-plugin-react-compiler`，target 19）用于自动记忆化；
- Component functions use `function` declaration; inline events/callbacks use arrow functions

## Hooks Specification (reause)

壳层的副作用一律交给 [`@reause/core`](https://github.com/hairyf/reause)（VueUse 的 React 1:1 移植）。
`react-use` 与 `@hairy/react-lib` 已从依赖中移除，**不要再引入**；新增依赖前先查
`.agents/skills/reause-functions` 的函数表，能在 reause 里找到的不要自己写。

| 需求 | 用 | 不用 |
| --- | --- | --- |
| 观察值变化后执行 | `useWatch` / `useWhenever`（真值触发一次） | `useEffect(deps)` |
| 仅挂载后执行一次 | `useMount` | `useEffect(…, [])` |
| 卸载时才需要清理 | `useEffect`（返回 cleanup），最后手段 | — |
| Tauri 事件订阅 | `useListen`（`src/hooks/use-listen.ts` = `listen` + 卸载注销 + 竞态防护） | `useEffect` + `listen` |
| DOM 事件 | `useEventListener`（缺省 window，可传 ref/目标） | `addEventListener` |
| 定时轮询 / 延时 | `useIntervalFn` / `useTimeoutFn` | `setInterval` / `setTimeout` |
| 延时 Promise | `promiseTimeout` | `new Promise(r => setTimeout(r, ms))` |
| 系统深浅色 | `usePreferredDark` / `useMediaQuery` | `matchMedia` + 手写监听 |
| 元素溢出判定 | `useElementOverflow` | 手写观测 / `scrollHeight` 比较 |
| 布尔开关 | `useToggle` | `useState(false)` + 手写 toggle |
| 跨组件瞬时事件 | `createEventHook` + `useListener`（键集中在 `src/config/hooks.ts` 的 `hooks`） | 全局 emitter / EventBus key |
| 查询「后端设置变更即失效」 | `useInvalidateOnSettingUpdated(queryKey)` | 各处手写 `useListen('setting_updated', …)` |
| iframe 消息桥（双向） | `useIframePost`（宿主 → iframe：origin 定向 + `source: 'dsh-desktop'`）/ `useIframeMessage`（iframe → 宿主：直接 iframe + origin 校验，按 `type` 分发）/ `useInvokeIframe`（iframe → 宿主 → `invoke`，带命令白名单） | 手写 `postMessage` 与来源校验；逐个桥比对 `data.source` |

- **`useEffect` 是最后手段**：只有「必须注册并注销一个外部资源，且 reause 没有对应 hook」时才写
  （例：Tauri 窗口 `onResized` / `onMoved`、需要取消的在途任务）；能拆成
  `useMount` / `useListen` / `useWatch` 的一律拆开。
- 副作用回调里不要自己维护 `disposed` 竞态标志：`useListen` 已处理注册竞态，
  而 `setState` 在已卸载组件上是 no-op。
- 同一模块的 TypeScript 类型与运行时值一起导入用 `import { type X, y } from '…'`，避免重复 import 语句。

## 目录与组件规划（参考 damn-reports）

```
src/
├── components/           # 通用件：无业务依赖、可跨面板复用的基础 UI
│   ├── ellipsis.tsx  empty.tsx  item.tsx  info.tsx  logs.tsx  logs.utils.ts
│   ├── modal.tsx         # overlastic 确认弹窗的通用载体
│   ├── panel.tsx         # 面板三件套：Panel.Header / Panel.Loadable / Panel.Progress
│   ├── primitives.ts     # tv 变体
│   └── toast-provider.tsx
├── config/               # 应用级配置（client / storage / hooks 事件总线 / query-keys 查询键）
├── ui/                   # 业务件：按领域分目录，一个文件一个组件
│   ├── config/           # 设置面板：backup / core / debug / plugin / profile（components/ 为面板子件：close-action / launch-on-login）
│   ├── dialog/           # 命令式弹窗：config / about / update / update-core
│   ├── pet/              # 桌宠窗口界面：hint
│   └── plugin/           # 插件界面：recovery
├── hooks/                # 可复用 hook（use-iframe-post / use-iframe-message / use-invoke-iframe / use-listen / use-window-draggable …）
│                         # use-zoom-factor：reause Electron 同名 hook 的 Tauri 移植，壳层用它把 store 里的缩放真值应用到 WebView；use-zoom-level 同源但未接线
├── layout/               # 壳层结构（index.tsx 根副作用 + components/：webview 选态、iframe 桥、navbar、setup*）
├── pet/                  # 桌宠窗口（独立入口 pet.html；hooks/ 为桌宠专属 hook，utils/ 为纯逻辑如 bubble / bubble-tracker）
├── store/modules/<name>/ # valtio store 模块（harness 内聚 readiness / runtime / utils）
├── styles/               # 全局样式（main.css + components/）
├── types/                # 后端契约类型（Rust 序列化形态）：core / plugin / profile / theme，barrel 导出
└── utils/                # 纯函数与跨模块单例（toast / clipboard / zoom / logger …）
```

- **命名**：文件名 kebab-case；组件用 `function` 声明、`PascalCase` 导出；props 类型 `<组件名>Props` 就近导出。
- **放哪里**：只依赖 HeroUI / reause / 纯工具 → `components/`；依赖 store、Tauri 命令或某个业务领域 → `ui/<领域>/`；只被某个 store 模块使用的纯函数 → 该模块目录内（如 `store/modules/harness/readiness.ts`）。
- **弹窗**：命令式弹窗（overlastic `useOverlay`）统一放 `ui/dialog/`；`components/modal.tsx` 只保留通用确认载体。
- **面板子件**：只被某个面板消费的子区块放同领域目录的 `components/`（如 debug 面板里的 `ui/config/components/close-action.tsx` / `launch-on-login.tsx`），面板文件只保留主结构。
- **根副作用**：壳层只在 `layout/index.tsx` 挂「启动 + 轮询 + 事件订阅 + holder」这类一次性副作用，不再为单个副作用另建组件文件。
- **iframe 桥**：出/入站只经 `useIframePost` / `useIframeMessage`；iframe 元素、iframe 自身的桥（通知 / 插件异常 / 剪贴板图片 / boot / 可见性 / 缩放 / invoke 转发）内联在 `layout/components/iframe.tsx` 的 `<Iframe>` 组件里（同一个 `switch (type)`），导航桥（侧边栏折叠与切换）留在 `layout/components/webview.tsx` 用同一对 hook 收发，其 iframe 侧实现收敛在 dsh-tauri 插件的 `client/register/sidebar.ts`（`ctx.layout.toggleSidebar` + 折叠状态回报），缩放快捷键同理在 `register/zoom-shortcut.ts`；Rust 侧只注入无法在插件期实现的桥（通知 API 垫片 / 剪贴板图片回退 / boot 探测 / WebKit 兼容；iframe 全局样式由 dsh-tauri-ui 的 `client/styles/global.cssr.ts` 挂载）；宿主侧不比对 `data.source`，也不为每个桥建 hook。
- **缩放真值**：`store.setting.zoom_factor` 是唯一真值（persist 插件写入的 `setting` 键与 Rust 共用同一份 `.store.dat`，Rust 在下一个窗口创建时按同一归一化规则应用）；快捷键与缩放桥只改真值，落到 WebView 由 `useZoomFactor` 完成；平台能力判定（macOS 10.15 没有 `WKWebView.pageZoom`）在 hook 内用 `@tauri-apps/plugin-os` 的 `type()` / `version()` 完成。
- **拆分**：列表行 / 卡片行等重复 JSX 抽成独立行组件并复用（`components/item.tsx`）；单文件过大时按「卡片 / 行 / 表单」拆成同目录下的兄弟文件。

## Function Declaration Specification

- **Named functions must use `function` declaration, not arrow functions**
- **Arrow functions can only be used when passed as callback parameters**

```tsx
// ✅ Correct
function Component() {
  function handleClick() {
    console.log('click');
  }
  return <button onClick={handleClick}>Click</button>;
}

// ✅ Correct: Arrow functions can be used for callbacks
useQuery({
  queryFn: async () => {
    return fetchData();
  },
});
```

## Data Processing Specification

### Use directly in pages

**Use case:** When data doesn't need additional processing after fetching

```tsx
function MyPage() {
  const { data } = useQuery({
    queryKey: queryKeys.simpleData, // 查询键统一登记在 src/config/query-keys.ts
    queryFn: () => fetchData(),
  });
}
```

### Create files in services directory

**Use case:** Backend type error handling, parameter processing, composite requests, polling, data caching, etc.

**File naming:** `use-get-{resource}.ts`, `use-post-{resource}.ts`, `use-put-{resource}.ts`, `use-delete-{resource}.ts`

```tsx
// services/use-get-exchange-rates.ts
export function useGetExchangeRates(params) {
  return useQuery({
    queryKey: [getApiExchangeRatesCurrencyPair.name, params],
    queryFn: () => getApiExchangeRatesCurrencyPair(params).then(res => res.data?.data),
  });
}
```

### 面板自己持有查询与变更（`use-dsh-*` 系列的落地方式）

- **`use-dsh-*` 系列已全部内联**：只被一个消费者用到的 DSH 查询/变更（含失效、事件同步）
  直接内联在该消费者里——「核心」`ui/config/core.tsx`、「档案」`ui/config/profile.tsx`、
  「插件」`ui/config/plugin.tsx`、外壳主题与插件列表同步 `layout/index.tsx`；不再为单一
  消费者新建包装 hook，后端契约类型统一从 `src/types` 取。
- **查询键集中在 `src/config/query-keys.ts`**：查询键是「谁在读同一份缓存」的契约（面板查询、store 重启
  失效、后端事件写入缓存都按同一份字面量），不要在业务文件里散落 `queryKey: ['plugins']` 这类字面量。
- **跨消费者的缓存由一处维护**：多个组件读同一份数据时，只有「写缓存」的逻辑收敛到一处
  （例：`layout/index.tsx` 订阅 `dsh-plugins-updated` 写入 `queryKeys.plugins`，插件面板 / 配置对话框
  异常角标 / 导航栏的 dsh-tauri 检测都只消费同一份缓存）。

## 类型放置

- Rust 侧结构体的序列化形态（camelCase 契约）统一放 `src/types/<领域>.ts`，经 `src/types/index.ts`
  以 `import type { HarnessCore } from '@/types'` 引用；组件 props 等纯前端类型仍就近定义在组件文件里。

## Conditional Rendering Specification

Use `If`, `Then`, `Else` components by `react-if-lite` package instead of ternary operators and `&&` operators

```tsx
// Basic usage
<If cond={!isLoading} else={<LoadingSpinner />}>
  <Content />
</If>

// Simple condition: use props
<If cond={isBasic} then={<GrayZuanIcon />} else={<ZuanIcon />} />

// Complex condition: use child components
<If cond={hasData}>
  <Then>
    <DataTable data={data} />
  </Then>
  <Else>
    <Empty />
  </Else>
</If>

// Specify render tag
<If cond={condition} as="div">
  {content}
</If>
```

## State Management Specification

### store 模块组织（参考 damn-reports）

`src/store/modules/<name>/` 是一个自洽模块，`index.ts` 是该模块**唯一**的公共出口
（barrel）：外部只从这里导入 store、类型与需要外用的工具函数，不深入模块内部文件。

```
src/store/
├── index.ts                  # 聚合出口：export const store = { ... }
└── modules/<name>/
    ├── index.ts              # barrel：export { x } from './store' / export type ... / utils
    ├── store.ts              # defineStore({ state, getters, actions })
    ├── types.ts              # 类型 + 对外常量
    ├── utils.ts              # 与 store 实例无关的纯函数（工厂、格式化、探测）
    └── constants.ts          # 时序/阈值常量（可选）
```

- 小模块（如 `setting`）可以只有一个 `index.ts`，不必强行拆分；
- 派生状态写 `getters`（复杂 getter 必须显式标注返回类型），不要在组件里重复计算；
- store↔store 协作走兄弟模块的 `index.ts`（如 `harness.launchAndWait()`），不直接引用对方的 `store.ts`；
- 模块级副作用（事件监听、初始 sync）放在 store 文件底部；组件一律 `import { store } from '@/store'`。

```tsx
// store/modules/user/index.ts
export { user } from './store'
export type { User } from './types'

// store/modules/user/store.ts
export const user = defineStore({
  state: () => ({ user: null as User | null }),
  getters: { hasUser(): boolean { return this.user !== null } },
  actions: { async fetchUser() { ... } },
})

// Usage
import { store } from '@/store'
const { user, hasUser } = useStore(store.user)
```

## Figma → Code

1. **Use theme tokens, not hardcoded colors** — `text-warning` over `text-[#7A5E38]`
2. **Component rules serve the design** — override styles when defaults don't match
3. **Structure is style** — map Figma frames directly to component tree, translate gap/padding directly
4. **Use component APIs** — express states via `value`, `size`, `variant` props instead of hand-writing styles

## tv Usage

Use `tv` when a component has multiple style variants/slots.

- `slots` defines all style areas; `variants` only writes changing styles
- Derive variant types via `VariantProps<typeof tvConfig>['variant']`

```tsx
export const dialog = tv({
  slots: {
    base: 'relative',
    icon: 'size-14 items-center justify-center rounded-full',
    iconContent: 'size-[22px]',
  },
  variants: {
    variant: {
      success: { icon: 'bg-[#E7EFE3]' },
      warning: { icon: 'bg-[#F5EAD3]' },
    },
  },
  defaultVariants: { variant: 'default' },
})
// Use: const { icon } = dialog({ variant })
```

## Overlastic Dialog Pattern (`@overlastic/react`)

**Use case:** Imperative dialog (confirm, PIN, KYC).

```
Hook       → useOverlay(Component) returns an async opener function
_layout.tsx → mount OverlaysProvider at root
Component  → render actual UI with useDisclosure
```

```tsx
// usage — resolves with the confirm value
const { foo } = useOverlay(FooComponent)
const result = await foo(options)
```

```tsx
// _layout.tsx — mount once at root
<OverlaysProvider>
  <App />
</OverlaysProvider>

// components/foo.tsx — render actual UI
import type { PropsWithOverlays } from '@overlastic/react'
import { useDisclosure } from '@overlastic/react'

export interface FooProps extends PropsWithOverlays, FooOptions { ... }

export function FooComponent(props: FooProps) {
  const disclosure = useDisclosure({ props, delay: 300 })
  return (
    <BottomSheet isOpen={disclosure.visible} onOpenChange={() => disclosure.cancel()}>
      {/* ... */}
      <Button onPress={() => disclosure.confirm(value)} />
    </BottomSheet>
  )
}
```

- Props are flat options; `PropsWithOverlays<Payload, Result>` types the payload and the promise result
- `disclosure.confirm(value?)` resolves the opener's promise, `disclosure.cancel()` closes without a result
- Component props/result types live in the component file, the hook imports them from there

## Backend Rules (Rust / Tauri)

1. **Comments**: Chinese only; `//!` for module headers, `///` for functions (focus on "why").
2. **Errors/Logs**: `Result<_, String>` errors need an uppercase prefix (e.g. `NODE_NOT_FOUND: ...`); log key paths.
3. **Settings**: new `Setting` fields need `#[serde(default...)]` and export in `config/mod.rs`.
4. **Windows**:
   - Spawn children with `CREATE_NO_WINDOW (0x08000000)`.
   - Kill the process tree when stopping services (`taskkill /T /F`) to avoid DLL lock on update.
   - Broadcast `WM_SETTINGCHANGE` after writing PATH; tell users to reopen terminals.
5. **CLI shim (`service/cli`)**:
   - Scripts at Win `%LOCALAPPDATA%\deepseek-harness\bin`, Unix `~/.local/bin`.
   - Prefer local Node (v22.19+ / v24+; v23 unsupported), fallback to bundled Node; mind escaping (`%`→`%%`, `'`→`'\''`).
   - Shim text must be English-only (cmd/ps1 parse by code page, Chinese breaks).
   - pnpm shim: forward user-installed pnpm first, else bundled node `dependencies/pnpm/bin/pnpm.cjs`.
   - Install skips when bundled installed **or** user pnpm on PATH (`Pnpm::check_installed`).
6. **Cross-platform/Tests**: Unix-only code gets `#[cfg_attr(windows, allow(dead_code))]`; unit tests in `#[cfg(test)] mod tests`, skip gracefully when restricted.
7. **Deps/Docs**: no heavy deps, prefer existing `windows-sys`; README minimal, en/zh synced.

## Pitfalls

- `dsh` CLI is a Node script (`dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`); CLI integration is **shim + PATH**. pnpm is also JS (`dependencies/pnpm/bin/pnpm.cjs`, npm tarball).
- AppData layout（核心共用）：`runtime/node.exe`、`dependencies/dsh/`、`dependencies/pnpm/`、`.store.dat` / `.store.dev.dat`（后者为 debug）；服务日志 `logs/dsh-web.log`（debug 为 `logs/dsh-web.dev.log`）；`$DSH_HOME` 在用户主目录（release `~/.dsh`，debug `~/.dsh.dev`）。
- Service args: `node bin.js --profile web --host 127.0.0.1 --port <setting.port>`; `cli::ensure` runs after install.
- 原生模块 ABI（issue #441）：预打包核心的原生模块（`fs-ext` 等 node-gyp 包）在 pkg 构建期编译，ABI 只与构建期 Node 大版本一致，而本地 Node 只按 semver 挑选。`service/core/runtime.rs::prepare_active_runtime` 在 spawn 前用 `NATIVE_PROBE_SCRIPT` 探测（require 核心里的原生包，`NODE_MODULE_VERSION` 不匹配即 ABI 失败）：先补 sharp/koffi 平台包，再改用与核心对齐的捆绑运行时（`config::set_prefer_bundled_node_runtime`，`get_node_binary_path`/`get_active_node_version`/`Nodejs::check_installed` 均受其影响，`launch.rs` 会在 prepare 后重新解析 node 路径），再 `npm rebuild`（用所选运行时自带的 npm），最后返回 `CORE_NATIVE_ABI_MISMATCH:` 诊断。CLI shim 的 node 选择仍是 semver-only。
- pnpm store 绑定（`ERR_PNPM_UNEXPECTED_STORE`）：pnpm 只在「自己解析出的 store」与档案 `node_modules/.modules.yaml` 里的 `storeDir` 一致时才继续安装，否则直接退出 —— 用户的 pnpm 用户级/全局配置（`store-dir`）或 `npm_config_store_dir` 环境变量把 store 指到别处（典型：用户在其他分区的工程里跑过 pnpm，pnpm 把那份 store 写进全局配置）时，档案安装会**在自身完全健康的情况下**失败，报错却是「插件安装失败」。`service/plugin/install/env.rs::build_plugin_envs` 因此把档案记录的 `storeDir` 显式注入子进程的 `npm_config_store_dir`（环境变量优先级高于 `.npmrc` 与全局配置，`Command::envs` 又会覆盖继承值），`ensure_pnpm` 的 store **主版本**匹配（`profile_store_major`）只解决 pnpm 10/11 布局不兼容，解决不了「同主版本、不同路径」。`storeDir` 解析见 `install/pnpm.rs::parse_store_dir_from_modules_yaml`。

## Summary

- **API Import**: 直接 `import { invoke } from '@tauri-apps/api/core'`（本仓库没有 `@/apis` 层）；类型就近定义在 hooks/组件文件中
- **Hooks**: 副作用一律用 reause（`useWatch`/`useMount`/`useListen`/`useEventListener`/`useIntervalFn`/`promiseTimeout` 等），`useEffect` 只在需要卸载清理且无对应 hook 时使用；`react-use` / `@hairy/react-lib` 已移除
- **Function Declaration**: Use `function`, not arrow functions
- **Conditional Rendering**: Use `If`, `Then`, `Else` components instead of ternary operators and `&&` operators
- **Data Processing**: Simple scenarios use `useQuery`/`useMutation` directly, complex scenarios create service files
- **State Management**: Multi-module shared state uses `defineStore + useStore`（valtio-define）；store 按 `src/store/modules/<name>/` 分模块，`index.ts` 是唯一出口；`defineScope`/`useScope` 已弃用（无引用），新代码勿用
