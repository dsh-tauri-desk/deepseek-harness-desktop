# Development Specification Document

DeepSeek Harness desktop (Tauri 2 + React 19), embeds the Harness UI served at `http://127.0.0.1:3080`.

- **端口隔离**：release 默认 `3080`，debug（`pnpm tauri dev` / `cargo build`）默认 `3081`，由 `config::setting::default_port()` 用 `cfg!(debug_assertions)` 区分，避免开发时与已运行的桌面端争用端口。
- **数据隔离（核心共用、数据不共用）**：node/`dependencies/dsh`/`dependencies/pnpm` 为共用核心（AppData）；debug 构建的 `$DSH_HOME` 默认为 `~/.dsh.dev`（`config::runtime::get_dsh_data_path` 用 `cfg!(debug_assertions)` 区分）且 store 用独立文件 `.store.dev.dat`（`config::setting::store_dat_file_name`），避免开发版与生产版会话/档案/端口状态互相污染，也防止 dev 版热重启把 release 的服务进程杀掉（`service/workflow::terminate_stale_harness_processes` 在 debug 下为 no-op，改由 `.dsh.dev/.harness.pid` 精确回收）。debug 构建不迁移旧数据（`service/migrate`）、不注册/注销 PATH、不写烘焙 DSH_HOME 的 `dsh` shim（`service/cli`）。
- **Windows 极简模式**：预装插件流程（`service/plugin`）对 Windows 用户列出「修复」项（`dsh-win-terminal-inspector`，黄色 chip 默认勾选），确认后 `dsh plugin add github:clearkurt/dsh-win-terminal-inspector` 从 GitHub 安装（桌面端**不内置**插件源码）；随后 `service/workflow/win_inspector.rs`（仅 Windows，幂等）写入 profile `cordis.patch.yml` 挂载行并创作 `$DSH_HOME/.agent-presets/minimal-win/` 用户 preset（Git Bash + danger-full-access，因为 agent preset 组成不受 profile patch 管辖）。
- **内置插件 host 依赖边界**：`packages/*/src/host/` 运行在独立的 `resources/node_modules` 中，禁止直接静态引用任何 `@deepseek-ai/*` 运行时包（包括 `import`、`export ... from` 和 `require`）；必须通过宿主上下文的 `loader.import()` 解析 DSH-owned 模块，并按需处理 `loader.unwrapExports()` 的导出形状。`@deepseek-ai/*` 仅可作为 host 的 type-only import，不能产生运行时依赖。
- **桌宠（`src/pet` + `dsh-tauri-pet`）**：渲染整体交给 `dsh-pet-component` 的 `<Pet>`（外部 npm 包，内部用 `@reause/core`），本仓库只保留设置状态、会话气泡聚合、原生窗口拖拽与命中穿透。预设宠物**不下载不安装**——`src-tauri/resources/preset-pets.json` 只登记远端素材地址与渲染参数（`config` / `uri` / `ext` / `kind` / `size`），pet 窗口直连远端播放并落 IndexedDB 缓存；`src/pet/main.tsx` 把全局 `fetch` 换成 `@tauri-apps/plugin-http` 的实现（其余命令与媒体元素不变），绕开 githubusercontent 的 CORS。macOS 用清单里 `uri.mac` / `ext.mac` 的 HEVC-alpha `.mov`（WKWebView 不认 VP9-alpha）。

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
    queryKey: ['simple-data'],
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

### Multiple module pages shared data: defineStore

```tsx
// store/modules/user.ts
export const user = defineStore({
  state: () => ({ user: null }),
  actions: { async fetchUser() { ... } },
});

// Usage
import { store } from '@/store';
const { user } = useStore(store.user);
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
- **Function Declaration**: Use `function`, not arrow functions
- **Conditional Rendering**: Use `If`, `Then`, `Else` components instead of ternary operators and `&&` operators
- **Data Processing**: Simple scenarios use `useQuery`/`useMutation` directly, complex scenarios create service files
- **State Management**: Multi-module shared state uses `defineStore + useStore`（valtio-define）；`defineScope`/`useScope` 已弃用（无引用），新代码勿用
