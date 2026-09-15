> 该文档大部分已固定，仅允许添加少量注释。

# DeepSeek Harness Desktop 开发规范文档

> **架构概览**：基于 Tauri 2 + React 19，内嵌服务运行于 `[http://127.0.0.1:3080](http://127.0.0.1:3080)` (Debug 环境默认 `3081`)。

---

## 1. 技术栈与常用命令 (Tech Stack & Commands)

* **前端**：React 19, TypeScript, Tailwind CSS v4, Vite (`src/`)
* **后端**：Rust, Tauri v2 (`src-tauri/`)
* **开发命令**：
```bash
pnpm install && pnpm dev    # 前端开发
pnpm typecheck              # 前端 TS 类型检查 (改动前端后必跑)
pnpm tauri dev              # 桌面端完整 Debug 模式
cargo check && cargo test   # Rust 检查与单元测试 (src-tauri 目录下)

```

---

## 2. 核心架构设计原则 (Architecture Principles)

* **端口与数据隔离**：
* **端口**：Release 默认 `3080`；Debug 默认 `3081`（通过 `cfg!(debug_assertions)` 隔离，防止端口争用）。
* **数据**：Debug 环境数据目录为 `~/.dsh.dev`，Store 文件为 `.store.dev.dat`。Debug 下 `terminate_stale_harness_processes` 为 no-op，改用 `.dsh.dev/.harness.pid` 精确回收进程，且不执行旧数据迁移与 PATH 注册。

* **内置插件宿主依赖边界**：
* `packages/*/src/host/` 运行于独立的 `resources/node_modules`。
* **禁止**静态引用任何 `@deepseek-ai/*` 运行时包（如 `import`/`require`），仅允许 `type-only import`。
* 必须通过宿主上下文 `loader.import()` 解析模块，并按需使用 `loader.unwrapExports()`。

* **Windows 极简模式**：
* 修复项 `dsh-win-terminal-inspector` 确认后从 GitHub 动态安装（桌面端不内置源码）。
* 自动挂载 `cordis.patch.yml` 并生成 `$DSH_HOME/.agent-presets/minimal-win/` 预设。

* **桌宠模块 (`src/pet` + `dsh-tauri-pet`)**：
* 预设宠物**不下载不安装**，由 `preset-pets.json` 登记远端 URL 并直连播放，落 IndexedDB 缓存。
* `src/pet/main.tsx` 使用 `@tauri-apps/plugin-http` 的 `fetch` 实现绕过 CORS。
* macOS 自动使用 `.mov` (HEVC-alpha) 格式。

---

## 3. 前端编码规范 (Frontend Specifications)

### 3.1 编码基础与函数声明 (Basics & Function Syntax)

* **组件与函数声明**：命名函数必须使用 `function` 关键字，箭头函数仅用于回调参数。
```tsx
// ✅ 正确
function UserProfile() {
  function handleSave() { /* ... */ }
  return <button onClick={handleSave}>Save</button>;
}

// ✅ 正确：回调中使用箭头函数
useQuery({ queryFn: async () => fetchData() });

```

* **自动记忆化**：已接入 `react-compiler`（target 19），**禁止使用** `useCallback` / `useMemo`。
* **UI 组件优先**：优先使用 `src/components` 和 HeroUI 组件，减少自定义 CSS 类。
* **i18n 规范**：禁止硬编码字符串。key 必须拍平（扁平点号命名，如 `setting.title`），同步维护 `src/i18n/locales/en-US.json` 与 `zh-CN.json`。

### 3.2 Hooks 使用指南 (`@reause/core`)

壳层副作用**统一使用 `@reause/core**`。已移除 `react-use` 与 `@hairy/react-lib`，禁止引入。

> ⚠️ **`useEffect` 是最后手段**：仅在“必须注册/注销 reause 未涵盖的外部资源”时使用。

| 场景 | 推荐 API | 禁用方式 |
| --- | --- | --- |
| 观察值变化 | `useWatch` / `useWhenever` | `useEffect(deps)` |
| 仅 Mount 时执行 | `useMount` | `useEffect(..., [])` |
| Tauri 事件订阅 | `useListen` (含自动注销/防竞态) | `useEffect` + `listen` |
| DOM 事件 | `useEventListener` | `addEventListener` |
| 定时轮询 / 延时 | `useIntervalFn` / `useTimeoutFn` | `setInterval` / `setTimeout` |
| 异步延时 | `promiseTimeout` | `new Promise(r => setTimeout(r, ms))` |
| 深色模式判定 | `usePreferredDark` / `useMediaQuery` | `matchMedia` 手写监听 |
| 开关状态 | `useToggle` | `useState(false)` 手写逻辑 |
| 跨组件事件 | `createEventHook` + `useListener` | 全局 EventBus |
| 设置变更失效查询 | `useInvalidateOnSettingUpdated(key)` | 手写监听 `setting_updated` |
| iframe 消息通信 | `useIframePost` / `useIframeMessage` | 手写 `postMessage` |

### 3.3 条件渲染规范 (Conditional Rendering)

禁止使用三元运算符与 `&&`，统一使用 `react-if-lite` 包中的 `<If>`、`<Then>`、`<Else>`。

```tsx
<If cond={!isLoading} else={<LoadingSpinner />}>
  <Content />
</If>

<If cond={hasData}>
  <Then><DataTable data={data} /></Then>
  <Else><Empty /></Else>
</If>

```

### 3.4 样式与 Variant 设计 (`tv`)

变体多或包含多 Slot 的组件统一使用 `tailwind-variants (tv)`，并使用主题 Token。

```tsx
export const cardStyle = tv({
  slots: { base: 'relative p-4', icon: 'size-6 rounded-full' },
  variants: {
    intent: {
      success: { icon: 'bg-success-100 text-success' },
      warning: { icon: 'bg-warning-100 text-warning' },
    },
  },
  defaultVariants: { intent: 'success' },
});

```

---

## 4. 状态与数据流控制 (State & Data Management)

### 4.1 Store 组织规范 (`src/store/modules/<name>/`)

使用 `valtio-define`，按模块封装，`index.ts` 作为**唯一**暴露出口。`defineScope` / `useScope` 已废弃。

```
src/store/modules/user/
├── index.ts      # 唯一出口 (barrel)：export { user } from './store'; export type ...
├── store.ts      # defineStore({ state, getters, actions })
├── types.ts      # 模块类型定义
└── utils.ts      # 纯逻辑工具函数

```

* 复杂派生状态写在 `getters` 中（需显式声明返回值类型）。
* Store 间的协作只能通过对方的 `index.ts` 调用，禁止越级引用 `store.ts`。

### 4.2 数据请求与查询 (`TanStack Query`)

* 查询键 (Query Keys) **必须**集中注册在 `src/config/query-keys.ts` 中。
* 单一消费者查询内联在组件中；跨组件共享数据由 `layout/index.tsx` 或指定管理者统一更新缓存。
* 复杂服务封装文件置于 `services/` 目录，命名遵循 `use-get-{resource}.ts` 规范。

### 4.3 弹窗规范 (`@overlastic/react`)

命令式弹窗统一放在 `src/ui/dialog/`，业务组件结合 `useDisclosure` 实现：

```tsx
import { useDisclosure, type PropsWithOverlays } from '@overlastic/react';

export interface ConfirmDialogProps extends PropsWithOverlays<{ title: string }, boolean> {}

function ConfirmDialog(props: ConfirmDialogProps) {
  const disclosure = useDisclosure({ props, delay: 300 });
  return (
    <Modal isOpen={disclosure.visible} onClose={() => disclosure.cancel()}>
      <Button onPress={() => disclosure.confirm(true)}>Confirm</Button>
    </Modal>
  );
}

```

---

## 5. 后端与 Rust 规范 (Backend Rules)

1. **注释要求**：仅使用中文注释。模块头用 `//!`，函数说明用 `///`（侧重阐述原因）。
2. **错误处理**：`Result<_, String>` 的错误信息必须包含大写前缀（如 `NODE_NOT_FOUND: ...`）。
3. **Windows 适配**：
* 子进程启动必须使用 `CREATE_NO_WINDOW (0x08000000)`。
* 停止服务时使用 `taskkill /T /F` 杀掉进程树，防止 DLL 锁死。
* 更新 PATH 后需广播 `WM_SETTINGCHANGE`。


4. **CLI Shim (`service/cli`)**：
* 脚本存放路径：Win `%LOCALAPPDATA%\deepseek-harness\bin`，Unix `~/.local/bin`。
* 优先使用本地 Node (v22.19+ / v24+，不支持 v23)，回退到捆绑 Node。
* Shim 文本**必须全英文**，避免编码页乱码。



---

## 6. 关键踩坑与修复避坑指南 (Pitfalls & Fixes)

* **原生模块 ABI 校验**：`prepare_active_runtime` 在启动前会运行 `NATIVE_PROBE_SCRIPT` 探测 ABI。若匹配失败，将自动补齐依赖或切至捆绑 Node 运行时。
* **pnpm Store 绑定冲突**：为防止全局 `store-dir` 冲突导致插件安装失败，`build_plugin_envs` 会将档案记录的 `storeDir` 显式注入为 `npm_config_store_dir` 环境变量。
* **YAML 补丁层错误 (Issue #525)**：损坏的 `cordis.patch.yml` 会被隔离为 `<Name>.broken-<Timestamp>`。若隔离/重命名失败，程序将直接中止并返回 `PATCH_LAYER_QUARANTINE_FAILED`，要求用户手动处理。
* **pnpm Workspace 多文档修复 (Issue #526)**：若 `pnpm-workspace.yaml` 被意外包含 `---` 多文档，解析器会自动尝试解析并合并为单文档落盘自愈（日志标记 `PROFILE_WORKSPACE_MULTI_DOCUMENT`）。
* **旧版 WebKit 缺失 Iterator 补丁 (Issue #539)**：在非 Windows 平台的 WebView 初始化时注入 `compat_iterator.js.inc` 垫片，补齐 ES2025 Iterator Helpers（在 `Object.getPrototypeOf(...)` 上挂载），防止旧 macOS WebKit 崩溃。
* **macOS 媒体权限配置 (Issue #214)**：必须同时在 `Info.plist` (声明 Usage Description) 与 `Entitlements.plist` (声明 `com.apple.security.device.*`) 中配置，相对路径基于 tauri bundle 运行时的 CWD 目录。
* **Linux 托盘点击适配 (Issue #386/#438)**：Linux 环境下通过 `linux_tray.rs` 基于 `tray-icon 0.25 (ksni)` 单独构建托盘，避免 muda 依赖版本冲突，通过 `Box::leak` 保活并在独立线程中处理事件。