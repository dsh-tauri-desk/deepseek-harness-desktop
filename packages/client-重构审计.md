# client 目录现状审计（重构前）

> 目标：参照开源范式（FSD / bulletproof-react / antfu 布局 / vite-plugin-inspect client 分层），
> 把各包 `src/client/` 从「一个文件混类型/常量/逻辑/组件/状态」拆成职责单一的分层结构。
> 本文记录审计结果，最终目录模板以专项调研结论为准。

## 共同问题

1. **大组件文件混合多层职责**：`.tsx` 文件同时含 纯解析/归一化逻辑 + 状态管理 + 副作用 + JSX + slot 注册。
2. **types.ts 混领域**：一个 `types.ts` 塞了互不相干的多个领域（协议、skills、mcp、runtime 快照、global Window 声明）。
3. **index.ts / barrel 混装配与 RPC**：RPC 客户端定义、injected 装配、apply 都挤在入口文件。
4. **注册与组件同文件**：`register*` / `install*`（含 retry timer / effect）与 UI 组件放一起。

## 逐包审计

### dsh-tauri-panel-extension/src/client（11 文件 / 1787 行，最严重）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `mcp-tab.tsx` | 685 | `parseMcpJson`/`parsePairs`/`mapToPairs`/`importGroups`(纯逻辑) + `McpTab` 组件 + 状态/轮询/副作用 + 4 个 Modal JSX |
| `skills-tab.tsx` | 358 | `policyTag`/`normalizeRepository`(逻辑) + `SkillsTab` 组件 + 刷新轮询 + 3 个 Modal |
| `extension-panel.tsx` | 137 | `SkillCreatorPrefill`(组件) + `registerSkillCreatorPrefill` + `ExtensionPanel`(组件) + `installExtensionPanel`(含 retry timer 注册逻辑) |
| `types.ts` | 201 | panel 协议 + skills + mcp + runtime 快照 + `declare global Window` 五个领域 |
| `index.ts` | 71 | `jsonApi`/`fetchJson`/`post`(RPC) + `createSkillsInjected`/`createMcpInjected`(装配) + `apply` |
| `styles.ts` | 113 | 单一职责（css-render 树）✓ |
| `workspace.ts` | 21 | 单一职责（chooseWorkspace 逻辑）✓ |
| `locale.ts` | 208 | 字典 + install（可再拆 installer） |
| `markdown-preview.tsx` | 11 | 组件 ✓ |
| `constants.ts` | 32 | 常量 ✓（含正则/延迟表） |

### dsh-tauri-panel/src/client（8 文件 / 787 行）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `service.tsx` | 228 | 类型(`PanelConversationController`/`ConversationLifecycleHooks`) + store(`panelViewStore`) + `ConversationSeat`/`PanelActionItem`(组件) + `shouldClosePanelForSidebarTarget`(DOM 逻辑) + `createPanelConversationController`(controller) + `installPanelService`(装配) |
| `sidebar.tsx` | 216 | `SidebarRootClone` 组件 + 折叠/linger 逻辑 + `installSidebarRoot` |
| `styles.ts` | 131 | ✓ 单一职责 |

### dsh-tauri-session/src/client（12 文件 / 1692 行）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `panel.tsx` | 382 | `buildRows`/`unionIds`/`workspaceTitleOf`/`formatTime`/`projectOptions`(纯逻辑) + `ArchivePanel` 组件 + 状态/过滤/删除确认 |
| `workspace-patch.ts` | 348 | `reactKey`/`collectSessionIds`/`workspaceFromRow`/`collectWorkspaceSessionIds`(DOM 解析) + `installWorkspaceArchivePatch`(DOM 补丁 controller) —— 纯非 React 逻辑，偏 host-ish |
| `store.ts` | ~190 | 共享状态 + 变更动作（rpc 已拆出） |
| `types.ts` | 153 | archive 页面 + runtime 快照混 |

### dsh-tauri-worktree/src/client（14 文件 / 1755 行）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `features/mode-select.tsx` | 302 | `mountModeSelectStyles`(样式) + `WorktreeModeSelect`(组件) + `waitForInputActions`(异步逻辑) + `WorktreeModeControl`(组件+提交拦截副作用) + `registerModeSelect` |
| `features/dialog.tsx` | 273 | `WorktreeDialog` + `CheckoutDialog` + `AbandonDialog` + `registerDialog` |
| `hydration.ts` | 271 | hydration controller（state machine + retry + subscriptions）—— 纯逻辑，可用 controller 拆分 |
| `session.ts` | ~145 | DOM 补丁（图标）+ 归组逻辑 |

### dsh-tauri-rightclick/src/client（12 文件 / 1307 行）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `menu.ts` | 352 | `installContextMenu` 一个巨型 controller（DOM 构建 + 定位 + 键盘 + 动作） |
| `actions.ts` | 184 | 业务动作（RPC/剪贴板/官方菜单选择） |
| `locate.ts` | 173 | DOM 定位解析 ✓ 职责单一 |
| `registry.ts` | 61 | 扩展注册表 ✓ |

### dsh-tauri-ui/src/client（13 文件 / 980 行）
| 文件 | 行数 | 混合内容 |
| --- | --- | --- |
| `sidebar.tsx` | 208 | `SettingsSidebar` 组件 + 宽度拖拽/聚焦/obstruction 副作用 + `registerSettingsSidebar` |
| `trigger.tsx` | 97 | `SettingsTrigger` 组件 + onboarding 逻辑 + `registerSettingsTrigger` |
| `settings-obstructions.ts` | 119 | DOM 补丁逻辑 ✓（可作 dom 层） |

## 已有范式线索（antfu 调研结论，专项调研返回后合并定稿）

来自之前 `antfu-collective` 系列调研的 client 组织建议（对应 vite-plugin-inspect 的
`client/components + client/logic + client/pages + client/stores + client/worker` 分层，
以及「Controller 是生命周期协调器，不是业务巨型文件」）：

```
client/
├─ controller/     # plugin-controller / lifecycle（生命周期协调，不含业务算法）
├─ rpc/            # client / events（ofetch 封装，一个能力一个 handler）
├─ state/          # operation-state / route-state（共享状态）
├─ features/       # 按 UI 特性拆分（operation / handoff / route …）
├─ lib/ 或 logic/  # 纯函数（解析/格式化/DOM 定位）
├─ hooks/          # React hooks（跨组件逻辑）
└─ dom/            # DOM 补丁（MutationObserver + capture）
```

要点：Controller 只负责 start/stop/订阅/失效；纯算法留在领域函数；index.ts 只装配。

## 拆分方向（待调研细化）

- 每包 `src/client/` 建议子目录：`types/`（按领域拆）、`logic/` 或 `lib/`（纯函数）、`hooks/`（React hooks）、`state/`（store）、`rpc/`（ofetch 客户端）、`components/` 或 `features/`（UI 组件，每组件一文件）、`dom/`（DOM 补丁）、`styles/`、`locale/`、`installers/` 或并入 apply。
- 一个 `.tsx` 组件文件只保留「该组件的状态 + JSX + 专属子组件」；纯解析/格式化函数 → `lib/`；跨组件逻辑 → `hooks/`；RPC → `rpc/`；注册 → `register/` 或 `apply.ts`。
- `types.ts` 按领域拆分（如 `types/panel.ts`、`types/skills.ts`、`types/mcp.ts`、`types/runtime.ts`），`client/types.ts` 作为聚合 barrel（保持 AGENTS.md 的「唯一集中位置」约定但内部分域）。

## 目标模板（专项调研定稿，2026）

专项调研已用 gh CLI 实拉 GitHub 默认分支 tree + 官方 docs 原文核验（零臆造），
验证到的真实范式：antfu/vitesse（components/composables/layouts/modules/pages/
stores/styles + 顶层 types.ts，无 utils/）、vite-plugin-inspect client
（components/logic/pages/stores/styles/worker）、bulletproof-react（features/<feature>/
{api,components,routes,types,index.ts} + shared {components/hooks/lib/providers/}，
index.ts 作公共 API + no-restricted-imports）、FSD（layers/slices/segments{ui,api,
model,lib}，依赖单向，官方明示 components/hooks/types 不是好段名）、shadcn/ui
（每组件一文件 + cva + cn 收 lib/utils）、WXT / vitesse-webext。

每包 client 目录定稿形态：

```
src/client/
├─ index.ts          # client barrel + apply 装配（只做 import/组装，无逻辑）
├─ constants.ts      # 客户端共享常量（slot id / classes / storage keys / effects）
├─ types/            # 按领域拆类型（types/<domain>.ts），types.ts 作为聚合 barrel
├─ lib/              # 纯函数：解析/格式化/归一化（如 parseMcpJson、normalizeRepository、buildRows）
├─ dom/              # DOM 补丁逻辑（MutationObserver + capture + Fiber key 读取）
├─ rpc/              # ofetch 客户端 + injected 装配（rpc/index.ts 导出 api）
├─ state/            # createExternalStore 共享状态 + 变更动作
├─ hooks/            # React hooks（跨组件逻辑、轮询、提交拦截）
├─ controller/       # 生命周期控制器（observer/timer/listener 收敛）
├─ components/       # 纯 UI 组件（每组件一文件：mcp-tab.tsx / skills-tab.tsx / conversation-seat.tsx）
├─ register/         # slot/协议注册（install*/register*，与组件分离）
├─ styles/           # css-render 树（现有 styles.ts，保持）
├─ locale/           # 双语字典 + installLocale（现有 locale.ts，保持）
└─ icons/            # 图标（现有 icons.tsx，保持）
```

拆分顺序（每包从最乱的文件开始）：
1. **types**：按领域拆（panel/skills/mcp/runtime），`types/index.ts` 聚合。
2. **lib**：抽出组件内的纯函数（parseMcpJson/parsePairs、policyTag/normalizeRepository、buildRows/unionIds/formatTime）。
3. **rpc**：index.ts 里的 RPC 客户端与 injected 装配拆到 `rpc/`。
4. **components**：把巨型 .tsx 拆成「组件文件（state+JSX）+ hooks（副作用/轮询）+ lib（纯函数）+ register（slot 注册）」。超过 ~200 行的组件文件应拆。
5. **controller**：hydrate/workspace-patch 这类纯逻辑状态机归入 `controller/`（可复用 dsh-tauri/client 的 createLifecycleController）。

> 注：AGENTS.md 的「client 类型/常量唯一集中位置」约定保留——`types/` / `constants/` 作为聚合目录存在，但内部按领域分文件，避免 200 行杂烩。
>
> 第二波（全 workspace 文件级重组）见 `packages/目录重组清单.md`：单一职责文件 → 同名目录
> （index.ts barrel），client `lib/→utils/`、`rpc→apis/`、`locale→locales/`、`features/icons→components/`、
> 安装器→`register/`、`state→config/`；host 领域单文件→`service/`、`state/storage→storage/`、
> `route/routes→routes/`、`tools→tools/`、`hooks→hooks/`、`constants/types→同名目录`。

## 重构后定稿（各包已按目标模板落地）

### dsh-tauri-panel-extension/src/client（已完成）
```
index.ts + types.ts(barrel) + constants.ts + locale.ts + styles.ts + icons.tsx + rpc.ts
types/{protocol,skills,mcp,runtime}.ts
lib/{mcp,skills}.ts
hooks/use-timers.ts
state/prefill.ts
components/{extension-panel,mcp-editor-form,mcp-import-dialog,mcp-tab,skill-creator-prefill,skills-tab}.tsx
register/{extension-panel,skill-creator-prefill}.ts(x)
```

### dsh-tauri-panel/src/client（已完成）
```
index.ts + types.ts + constants.ts + locale.ts + styles.ts
service/{store,dom,controller,hooks}.ts
service/components/{conversation-seat,action-item}.tsx
```

### dsh-tauri-session/src/client（已完成）
```
index.ts + types.ts(barrel) + constants.ts + locale.ts + styles.ts + store.ts + rpc.ts + icons.tsx
types/{archive,runtime,ui,locale}.ts
lib/{archive-rows,sort}.ts
dom/workspace-patch.ts
components/{archive-panel,menu-select}.tsx
register/archive-section.ts
```

### dsh-tauri-worktree/src/client（已完成）
```
index.ts + types.ts(barrel) + constants.ts + locale.ts + styles.ts + store.ts + rpc.ts + icons.tsx + handoff.ts + hydration.ts
types/{worktree,runtime,locale}.ts
lib/worktree.ts
dom/session-icons.ts
register/{dialog,surface,mode-select}.ts
features/{dialog,surface,mode-select}.tsx
```

### dsh-tauri-rightclick/src/client（本轮完成）
```
index.ts + types.ts(barrel) + constants.ts + locale.ts + styles.ts + clipboard.ts + dialog.ts + confirm-dialog.ts + registry.ts + locate.ts + actions.ts + menu.ts
types/{runtime,locale}.ts
lib/editable.ts
dom/menu-item.ts
```
menu.ts 从 352 行巨型 controller 收敛为「目标解析 + 菜单组装 + 生命周期」：
DOM 构建（菜单项/分隔线/定位）→ dom/menu-item.ts；选区三态（替换/全选）→
lib/editable.ts；官方菜单转交（officialSelect 统一会话/工作区两变体）→ actions.ts。

### dsh-tauri-ui/src/client（本轮完成）
```
index.ts + types.ts + constants.ts + locale.ts + styles.ts + store.ts + sections.ts + seat.ts + icons.tsx + nav-icon.tsx
dom/settings-obstructions.ts
components/{sidebar,trigger}.tsx
hooks/use-rail-drag.ts
register/{sidebar,trigger}.ts
```
sidebar.tsx 拆为「组件（state+JSX） + 拖拽钩子（hooks/use-rail-drag.ts） +
DOM 补丁（dom/settings-obstructions.ts） + 槽位注册（register/sidebar.ts）」；
trigger.tsx 拆为组件 + 注册（register/trigger.ts）。

### dsh-tauri/src/client（无需再拆）
```
index.ts(barrel) + apply.ts + compat.ts + constants.ts + controller.ts + error.ts + http.ts + storage.ts + store.ts + bridge.ts
types/{bridge,context,global,inject,runtime,index}.ts
```
本身即共享工具层，已按职责单文件组织，保持现状。
