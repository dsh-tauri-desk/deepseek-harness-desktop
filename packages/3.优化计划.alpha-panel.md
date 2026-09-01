# alpha panel 优化计划

> 状态：调研完成，待评审实施
> 关联插件：`dsh-tauri-panel` / `dsh-tauri-panel-extension` / `dsh-tauri-panel-placeholder`
> 核心版本：当前 rc.2（`0.1.1-rc.2`，release 核心）；目标 alpha（`0.1.2-alpha.3`，dev 核心）

---

## 一、现象与目标

### 1.1 现象

- **alpha 版本中**：右侧内容区（对话内容列）左右两侧有拖拽手柄（`WidthHandle`），可拖动改变内容宽度，宽度偏好持久化到 `localStorage['dsh.conversation.contentWidth']`；
- **dsh-tauri-panel 内容区**：面板视图（`ConversationSeat`）内容列宽度固定（回退 `780px`），**不可拖动**。

### 1.2 目标

1. 调研 alpha 相比当前 rc.2 多出哪些**可用接口**（公开服务面 / 槽位 / CSS 变量协议）；
2. 在保持**向后兼容**（rc.2 与 alpha 双版本共存）的前提下接入可用接口，让面板内容区获得与 alpha 一致的**宽度拖拽**能力；
3. 输出本文档作为实施方案。

---

## 二、调研结论：alpha 可用接口清单

以下接口均为对照**已安装**核心核实（alpha：`dev/dependencies/dsh`；rc.2：`dependencies/dsh`）。

### 2.1 `ctx.layout` 服务面（`LayoutController` / `ILayout`）

**rc.2 与 alpha 表面完全一致**，均暴露三个方法：

```ts
interface ILayout {
  toggleSidebar: () => void // 侧边栏 折叠 ⟷ 默认宽度
  openDetails: () => void // 打开右侧 details 列（默认 360px，clamp 300–520）
  closeDetails: () => void // 关闭右侧 details 列
}
```

> 结论：**没有新增公开方法**。`setSidebar(px)` / `setDetails(px)` / `setNarrow` 只在布局 store 内部（`attachPanels` 私有注入），不对外暴露。
> 当前 `dsh-tauri-panel` 只消费了 `toggleSidebar`；`openDetails` / `closeDetails` 是**可用但未使用**的接口。

### 2.2 AppFrame 三列骨架与拖拽手柄

`dsh-client-ui-layout` 的 root 注册渲染 `sidebar | center | details` 三列：

| 列 | 槽 | scope | 拖拽 |
| --- | --- | --- | --- |
| sidebar | `sidebar` | root | 隐形 hit strip（`DragHandle[data-side=sidebar]`） |
| center | `conversation` | session-maybe | 无列级手柄（内容宽度拖拽在对话根内，见 2.4） |
| details | `details` | session | 浮动 pill（`DragHandle[data-side=details]`） |

- 宽度契约：sidebar `264–420`（默认 280），details `300–520`（默认 360），0 = 关闭；
- details 列**常驻挂载**（宽度 0 也不卸载子树），concession 链在窗口变窄时先压缩 details 再自动关闭；
- 面板几何是瞬态的（不写 localStorage），reload 复位。

### 2.3 `details` 槽（右侧列）——新增可用承载点

- rc.2：`dsh-client-ui-conversation` 的 `DetailsPanel` 占据，`openDetails` 由工具行触发；
- alpha：改为 `dsh-client-ui-chat` 的 `DetailsPanel` 占据（包拆分），同样走 `ctx.layout.openDetails()/closeDetails()`；
- 槽声明：`single` / `session`，无 owner props（sessionId 由框架注入）；
- **对插件的意义**：第三方可以 `priority: -1` shadow 官方条目，把自己的内容放进**原生可拖拽**的右侧列，免费获得浮动 pill 手柄。

### 2.4 对话内容宽度拖拽（alpha 新增，rc.2 没有）

alpha `dsh-client-ui-conversation` 的 `ConversationRoot` 内实现：

- 对称 `WidthHandle`（左/右各一）：pointer capture + rAF 节流，双侧同时写入**同一个居中宽度**（外向拖拽 2× 指针位移）；
- CSS 变量协议（任何插件可读写）：
  - `--dsh-conversation-column-width`：ResizeObserver 发布的列宽；
  - `--dsh-chat-user-width`：拖拽偏好（拖动中实时写入）；
  - `--dsh-chat-content-width`：`var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width,0px) * .64), 920px))`；
- 持久化键：`localStorage['dsh.conversation.contentWidth']`；
- 约束：`CONTENT_MIN = 640`，`CONTENT_EDGE_BUDGET = 176`（两侧各留 88px 放手柄），`resolveContentWidth` 把偏好 clamp 进 `[640, column - 176]`；
- 手柄 hover 发光条跟随指针 Y（`--dsh-width-handle-pointer-y`）。

rc.2 对比：`--dsh-chat-content-width: 748px` 固定，**无手柄、无偏好、无自适应**。

### 2.5 其他 alpha 差异（与面板无关或低相关，仅记录）

| 差异 | rc.2 | alpha | 对面板影响 |
| --- | --- | --- | --- |
| layout inject | `slots, theme` | `slots, theme, locale` | 无（panel 已 inject layout） |
| 布局 store 实现 | `dsh-client-runtime/client` defineStore | `@deepseek-ai/dsh-client-store` defineStore | 内部实现迁移，服务面不变 |
| theme presenter | 配色 token | 追加 `--dsh-content-font-size` / `--dsh-content-font-delta` | 面板可跟随字号变量（可选） |
| conversation inject | — | 新增 `settingsScope`、`uiWorkspace` | panel 不依赖 |
| `shell.overlay` 槽 | list/root | list/root | 均可用于浮动层（非本次目标） |

---

## 三、组件复用调研：官方有没有可直接复用的组件？

> 问题：`dsh-tauri-panel` 的侧边栏是**整槽克隆**（`SidebarRootClone`），核心每次更新都要同步改结构。是否有官方组件可以直接复用、从而减少克隆维护？

### 3.1 结论速览

| 层级 | 官方包 | 可复用？ | 证据 |
| --- | --- | --- | --- |
| **原子组件** | `@deepseek-ai/dsh-client-ui-primitives` | ✅ **可直接 import** | 已注册进 web-frontend dist 模块表（seed 模块）；rc.2 与 alpha 均有导出；仓库多个插件已在用 |
| **布局骨架** | `dsh-client-ui-layout`（AppFrame / DragHandle） | ❌ 不导出 | client.js 只导出 `LayoutController` / `apply` / `inject` |
| **侧边栏外壳** | `dsh-client-ui-sidebar`（SidebarRoot） | ❌ 不导出 | client.js 只导出 `apply` / `inject` |
| **内容宽度拖拽** | `dsh-client-ui-conversation`（WidthHandle） | ❌ 不导出 | client.js 只导出 controller 类，无组件 |
| **源码导入** | 各包 `./src/*` | ❌ npm 包不可用 | exports 有 `./src/*` 映射，但 `files` 数组不含 `src` → 源码**未随包发布**（仅 monorepo 内开发可用） |

### 3.2 可复用面：`dsh-client-ui-primitives`（运行时 seed，仓库已有消费先例）

**运行时可用**：web-frontend dist 的模块表 `function zp()` 明确注册
`"@deepseek-ai/dsh-client-ui-primitives": Fp` —— 即插件 client bundle 中
`require("@deepseek-ai/dsh-client-ui-primitives")` 在 alpha 运行时由模块表解析（与
`react` / `cordis` / `dsh-client-store` / `dsh-client-ui-slots` 同为 seed 模块）。

**仓库已有先例**（无需引入新机制，只改 import 面）：

| 插件 | 已在复用 |
| --- | --- |
| `dsh-tauri-session` | `Button` / `Input` / `Menu` / `Modal` / `MenuEntry` |
| `dsh-tauri-ui` | `NavIcon`（官方图标映射） |
| `dsh-tauri-panel-extension` | `Button` / `Modal` / `StateDot` |
| `dsh-tauri-rightclick` | `Button` / `Modal` |
| `dsh-tauri-worktree` | `Menu` / `IconChevronDownOutline14` |

**已核实的导出面**（rc.2 d.ts `lib/types/index.d.ts`）：

- 控件：`Button` / `Input` / `Pill` / `Menu` / `HoverCard` / `Modal` / `Toast` / `Tooltip` / `StateDot` / `DisclosureRow` / `OnboardingSurface` / `RiskConfirmation` / `ConnectionBanner`
- 品牌：`FishLogo` / `BrandWordmark`（官方 sidebar 内部就在用）
- 富内容：`JsonTree` / `TerminalBlock` / `ReadBlock` / `DiffBlock` / `SearchBlock` / `WebBlock` / markdown 族（`MarkdownText` / `MessageText` / `CodeBlock` / `JsonBlock`）
- hooks：`useAnchoredPosition` / `useAnchoredMaxHeight` / `useDismissOnOutsidePointer` / `use-copy-feedback` / `writeClipboard`
- icons：`export * from './icons'`（官方图标全集）

> 当前 `dsh-tauri-panel/src/client/icons.tsx` 注释明确说「loader 模块表虽提供该模块，
> 但自绘零外部表面、跨部署更稳」——这是**刻意取舍**，不是官方不可用。改用时权衡：
> 自绘 = 零依赖但结构升级需人工跟；复用 primitives = 图标/控件跟随官方，但要求模块表
> 稳定提供（alpha/rc.2 均已确认提供）。

### 3.3 不可复用面：布局骨架（官方设计如此，非遗漏）

- `SidebarRoot`、`AppFrame`、`DragHandle`、`WidthHandle`、`DetailsPanel` 全部是**包内私有**；
  client 导出面只有 `apply` / `inject` / controller 类；
- 官方 UI 扩展机制是 **slot 组合 + 整槽 shadow**（`renderSlot("sidebar.brand.mark")` 等），
  **不是组件 props 定制**；SidebarRoot 本身也是用子槽拼出来的；
- 因此「整槽替换 sidebar」在当前官方架构下是**唯一**形态（面板需要紧凑 logoRow + 面板区，
  官方无此形态），克隆不可避免；
- `./src/*` 的 exports 映射**不随 npm 包发布**（`files` 无 `src`），不能靠 import 官方源码解决。

### 3.4 降低「核心升级 → 同步克隆」成本的对策

1. **克隆面最小化**（已做，保持）：只克隆必须改的骨架（logoRow 高度、面板区、新会话入面板区），
   其余官方子槽（brand.mark / brand.name / workspaces / footer.action / settings）一律
   `<SlotOutlet>` 透传——官方子槽内部结构变化天然免疫；
2. **能力探测 + 降级**（AGENTS.md 退级阶梯）：克隆依赖的官方结构（sidebar 槽 props
   `collapsed/width`、子槽名）变化时，`SlotOutlet` 缺省回退、条目不注册，绝不白屏——
   升级成本 = 适配新槽名/新 props，而非重写 UI；
3. **原子层改用官方 primitives**：面板图标（ChatOutline / PanelLeftOutline / FishMark 等
   自绘 SVG）、需要新增的菜单/确认弹窗/Tooltip 改用 primitives（已进模块表），
   随官方主题与图标演进，减少自绘维护；
4. **宽度拖拽协议沿用官方变量**（方案 A）：`--dsh-chat-content-width` / localStorage 键与
   官方共用，官方未来若导出 WidthHandle，可平滑替换自绘手柄；
5. **可选：上游诉求**：向 deepseek-harness 提特性请求——导出 `SidebarRoot`（或提供
   「紧凑模式 + 面板区」官方形态），长期消除克隆。当前版本不做依赖。

---

## 四、差距分析：为什么面板内容区不可拖动

1. `dsh-tauri-panel` 以 `priority: -1` 动态注册 `conversation` 槽条目，**整体 shadow 官方 `ConversationRoot`**；
2. 官方 `ConversationRoot`（含 `WidthHandle`、`--dsh-conversation-column-width` 发布、偏好读写）随之不再渲染；
3. 面板自己的 `ConversationSeat` 只有 `max-width: var(--dsh-chat-content-width, 780px)`，**既不发布列宽变量、也不渲染手柄、也不读写偏好** → 内容列固定宽度、不可拖动。

> 根因：面板内容区宽度能力是「自绘」的，alpha 的宽度拖拽是 `ConversationRoot` 内部实现（未导出为组件），**必须镜像其模式自实现**，而不是 import 一个官方组件。

---

## 五、接入方案（向后兼容优先）

按「能力探测 → 自实现镜像 → 协议扩展可选」三档递进，全部对 rc.2 / alpha 双版本兼容。

### 方案 A（必做，核心）：面板内容区宽度拖拽

在 `ConversationSeat` 内镜像 alpha `ConversationRoot` 的宽度拖拽模式：

1. **发布列宽**：ResizeObserver 监听面板根元素，写入 `--dsh-conversation-column-width`；
2. **读写偏好**：挂载时读 `localStorage['dsh.conversation.contentWidth']`（与官方共用同一键，面板宽度与对话宽度偏好一致）；拖拽结束 commit 写回；
3. **渲染手柄**：内容列左右各渲染一个 `data-width-handle` 手柄（pointer capture + rAF 节流 + 外向 2× 位移），`data-side="left|right"`，hover 发光条跟随指针 Y；
4. **解析宽度**：复用 alpha 的 `resolveContentWidth` 语义（clamp `[640, column-176]`；无偏好时自适应 `max(680, min(col*0.64, 920))`），写入 `--dsh-chat-user-width` / `--dsh-chat-content-width`；
5. **rc.2 兼容**：rc.2 下官方不发布这些变量，面板自给自足（自己的根元素写变量、自己的手柄、自己的偏好读写），行为完全一致且不依赖 alpha 独有 API；
6. **降级**：localStorage 缺失/损坏 → 按无偏好自适应；`ResizeObserver` / PointerEvent 缺失（旧 WebView）→ 隐藏手柄、保持固定宽度（与现状一致），并 console.warn 一次。

### 方案 B（可选）：details 列承载面板内容

- 在 `panel.protocol` 增加可选的 `side: 'details'` 规格（`PanelContentSpec` 加可选字段，**缺省仍走 conversation 替换，零破坏**）；
- 实现：`priority: -1` shadow `details` 槽条目 + `ctx.layout.openDetails()/closeDetails()`；
- 收益：获得 AppFrame **原生浮动 pill 拖拽**，无需自绘手柄；
- 约束与风险：
  - `details` 槽 `scope: "session"` → 仅在存在会话时渲染（面板如 Skills/MCP 是工作区级，需自行判断空态）；
  - 会 shadow 官方工具详情面板（skill 管理场景下可接受，需在协议文档中声明）；
  - 列宽 clamp 300–520，与对话内容列（640–920）不同量级，适合「右侧工具面板」类内容；
- **建议**：本次只预留协议字段 + 能力探测，实际渲染接入放二期（避免一次改动面过大）。

### 方案 C（可选）：`panel.protocol` 协议扩展

保持现有三个方法（`ActionItem` / `renderPanelContent` / `closePanelContent`）**原样不动**，追加**可选**能力：

```ts
interface PanelProtocol {
  // …既有方法不变…
  setPanelWidth?: (px: number) => void // 程序化设置内容宽度（clamp 到契约范围）
  resetPanelWidth?: () => void // 清除偏好，恢复自适应
  getPanelWidth?: () => number | null // 当前内容宽度（含偏好）
  openDetails?: () => void // 透传 ctx.layout.openDetails
  closeDetails?: () => void
}
```

- 消费方（extension / placeholder）一律 `?.()` 探测调用，老版本协议对象无这些字段时自然 no-op；
- 文档同步到 `PROTOCOL.md`（当前仓库无该文件，见 §七 文档任务）。

---

## 六、实施步骤（含文件规划）

> 目录约定遵循 `packages/AGENTS.md` 新结构（`constants/` `types/` `locales/` `styles/` `components/` `register/` `store/` `service/` `utils/` `hooks/` `dom/`），本计划按目标结构落地；当前仓库正处于该重构分支（`refactor/packages-host-client-shared`），实施时先对齐既有重构状态。

### 6.1 常量（`dsh-tauri-panel/src/client/constants/width.ts` 或并入现有 constants）

```ts
export const PANEL_WIDTH_PREF_KEY = 'dsh.conversation.contentWidth' // 与官方共用
export const PANEL_CONTENT_MIN = 640
export const PANEL_CONTENT_EDGE_BUDGET = 176
export const PANEL_CONTENT_DEFAULT = 780 // rc.2 时代回退值
export const PANEL_WIDTH_VARS = {
  column: '--dsh-conversation-column-width',
  user: '--dsh-chat-user-width',
  content: '--dsh-chat-content-width',
  pointerY: '--dsh-width-handle-pointer-y',
} as const
```

### 6.2 纯函数（`utils/width.ts`，可单测）

- `readWidthPreference(storage): number | null`
- `resolveContentWidth(column, preference): number`（镜像 alpha 语义）
- `clampWidth(px, min, max): number`

### 6.3 手柄组件（`components/width-handle.tsx`，全小写 kebab-case）

- 镜像官方 `WidthHandle`：pointer capture / rAF 节流 / `onStart/onDrag/onCommit/onEnd` 回调；
- `data-width-handle` + `data-side` + `data-dragging` 属性；
- 样式由 css-render 节点生成（`styles/`），hover 发光条跟随 `--dsh-width-handle-pointer-y`。

### 6.4 内容列改造（`components/conversation-seat.tsx`）

- 根元素 ref + ResizeObserver 发布 `--dsh-conversation-column-width`；
- 宽度解析 + 偏好读写（`createLifecycleController` 收敛 observer / pointer 监听）；
- `phase === 'active'` 语义下渲染左右手柄（面板打开即视为 active）；
- 保持既有 `max-width: var(--dsh-chat-content-width, 780px)` 回退。

### 6.5 协议扩展（`service/` + `types/`）

- `PanelContentSpec` 增加可选 `side?: 'conversation' | 'details'`（缺省 conversation）；
- `PanelProtocol` 增加可选方法（方案 C），`service/index.ts` 装配时按能力探测提供；
- `panelViewStore` 增加宽度快照字段（可选）。

### 6.6 消费者同步

- `dsh-tauri-panel-extension`：`register/extension-panel.tsx` 中协议调用改 `?.()`（零行为变化）；
- `dsh-tauri-panel-placeholder`：`types.ts` 协议类型同步可选字段。

### 6.7 验证

```bash
pnpm --filter dsh-tauri-panel typecheck
pnpm --filter dsh-tauri-panel-extension typecheck
pnpm run lint --fix
pnpm run test -- --run          # 新增 width 纯函数单测
pnpm run build                  # 部署内置插件到 src-tauri/resources
```

手工验收（alpha 核心，debug 端口 3081）：
1. 打开面板（如扩展面板）→ 内容列左右出现手柄；
2. 拖动手柄改变宽度 → 释放后刷新页面宽度保持（localStorage 持久化）；
3. 清空 `dsh.conversation.contentWidth` → 回退自适应宽度；
4. 切换到官方对话 → 宽度偏好互通（同一键）；
5. rc.2 核心（release 3080）回归：面板宽度行为一致、无报错。

---

## 七、文档任务

- 新建 `packages/dsh-tauri-panel/PROTOCOL.md`：目前代码注释多处引用但仓库无此文件；写入 `panel.protocol` 完整契约（含本次新增可选字段与「先探测后调用」约定）；
- 更新 `packages/dsh-tauri-panel/README.md`（能力描述）；
- 更新 `packages/dsh-tauri-panel-placeholder` / `dsh-tauri-panel-extension` README 中与协议相关的说明。

---

## 八、风险与降级

| 风险 | 缓解 |
| --- | --- |
| rc.2 与 alpha 的 `--dsh-chat-content-width` 语义差异（固定 748 vs 自适应） | 面板自给自足发布变量，不依赖官方根元素 |
| 与官方对话宽度偏好共用 localStorage 键可能互相影响 | 有意的产品一致行为；文档声明；可一键 `resetPanelWidth` 清除 |
| Pointer capture / rAF 在旧 WebView 缺失 | 能力探测降级为固定宽度 + console.warn |
| details 列 shadow 官方详情面板 | 方案 B 二期接入，默认不启用；协议字段可选 |
| 重构分支未完成导致文件路径漂移 | 实施前先对齐 `refactor/packages-host-client-shared` 当前状态再落盘 |

---

## 九、结论

- alpha **存在更多可用接口**：`ctx.layout.openDetails/closeDetails`（rc.2 已有、未使用）、`details` 槽（可 shadow 原生拖拽右列）、对话内容宽度拖拽协议（CSS 变量 + localStorage，alpha 新增）；
- **推荐接入**：方案 A（面板内容区宽度拖拽，自绘镜像，双版本兼容）为本次必做；方案 C（协议可选方法）一并落地；方案 B（details 列承载）二期；
- **向后兼容原则**：一切新增均为「可选字段 / 能力探测 / 自实现镜像」，既有协议方法与消费方零破坏。

