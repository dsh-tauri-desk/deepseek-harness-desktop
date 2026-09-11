# dsh-tauri-panel 协议

`dsh-tauri-panel` 客户端插件体（browser half）通过槽位与反射服务向其他客户端插件
暴露面板能力。本文件是 `panel.protocol` 的完整契约（代码注释多处引用）。

## 1. 服务面：`panel.protocol`

宿主在 `apply()` 期间经 `ctx.reflect.provide('panel.protocol', api)` 同步发布
（早于兄弟 effect，第三方在 apply 阶段即可取用）。

```ts
interface PanelProtocol {
  // —— 基础（自 0.1.1-rc.2 起，稳定）——
  ActionItem: (props: PanelActionItemProps) => ReactElement
  renderPanelContent: (spec: PanelContentSpec) => void
  closePanelContent: () => void

  // —— 可选能力（0.1.2-alpha 线起；老版本协议对象无这些字段）——
  setPanelWidth?: (px: number) => void
  resetPanelWidth?: () => void
  getPanelWidth?: () => number | null
  openDetails?: () => void
  closeDetails?: () => void
}
```

### 1.1 基础方法

| 方法 | 语义 |
| --- | --- |
| `ActionItem(props)` | 面板区条目组件：样式/折叠态/active 态全由宿主承担，子插件只填 `id` / `icon` / `onClick` / `children` |
| `renderPanelContent(spec)` | 切换会话区替换：未替换则打开 `spec.render`，已替换则关闭恢复官方会话界面（toggle 语义）；再调同 `id` → dispose 句柄 → 官方恢复 |
| `closePanelContent()` | 显式恢复官方会话区；面板内需要跳转到会话的动作用它 |

会话区替换的承载槽随核心版本变化（宿主同时 inject 两个候选，任一版本只有
对应声明存在，另一候选静默等待）：

| 核心版本 | 承载槽 | 注册形状 |
| --- | --- | --- |
| ≤ `0.1.2-rc.1` | `conversation`（`single`） | `{ name: 'conversation', id, priority: -1 }` |
| ≥ `0.1.5-rc.1` | `main`（`keyed`，cell key `conversation`） | `{ name: 'main', key: 'conversation', priority: -1 }` |

> 0.1.5-rc.1 起布局改为 `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`，
> 官方会话条目注册在 `main` 槽的 `conversation` cell，旧的 `conversation` 槽
> 已不复存在。消费方无需感知该差异——`renderPanelContent` 仍是唯一入口。

`PanelContentSpec`：

```ts
interface PanelContentSpec {
  id: string // 唯一标识；active 态以它匹配 ActionItem
  render: ComponentType<{ t?: (key: string) => string }>
  locale?: string // 文案 NS，默认宿主 'panel'
  side?: 'conversation' | 'details' // 可选（预留）：承载侧；当前仅 conversation 生效
}
```

### 1.2 可选方法（「先探测后调用」约定）

所有可选字段**老版本协议对象不存在**。消费方一律用可选链探测调用，绝不断言存在：

```ts
protocol.setPanelWidth?.(720)
protocol.resetPanelWidth?.()
protocol.openDetails?.()
```

| 方法 | 语义 | 能力来源 |
| --- | --- | --- |
| `setPanelWidth(px)` | 程序化设置内容宽度（clamp 进契约范围 `[640, column-176]` 并持久化） | 宽度控制器（方案 A） |
| `resetPanelWidth()` | 清除宽度偏好，恢复自适应宽度 | 同上 |
| `getPanelWidth()` | 当前内容宽度（含偏好）；无面板挂载时返回偏好或 `null` | 同上 |
| `openDetails()` | 透传 `ctx.layout.openDetails()`：打开右侧 details 列（默认 360px，clamp 300–520） | 宿主按 `ctx.layout` 能力探测提供 |
| `closeDetails()` | 透传 `ctx.layout.closeDetails()` | 同上 |

> `details` 列承载（方案 B）为二期：本期 `side: 'details'` 仅保留字段与类型，
> 不渲染。第三方希望立即使用原生可拖拽右侧列，可自行 `priority: -1` shadow
> 官方 `details` 槽条目（`single`/`session`，无 owner props），并用
> `ctx.layout.openDetails()/closeDetails()` 开关。

## 2. 槽面：`sidebar.panel.action`

面板区功能项经 `sidebar.panel.action` 槽注册（`list` / `root`，由 `dsh-tauri-panel`
条目 children 声明，非官方槽）：

```tsx
// 等待协议就绪（缺失时降级：不注册条目，旧核心/宿主未装）
const protocol = ctx.reflect.get('panel.protocol') as PanelProtocol | undefined
if (!protocol)
  return () => {}

const icon = undefined
const label = '我的面板'
return ctx.slots.register(
  {
    name: 'sidebar.panel.action',
    id: PLUGIN_ID,
    order: 10,
    priority: 0,
    locale: LOCALE_NAMESPACE,
    inject: () => ({ protocol }),
  } as never,
  props => <props.protocol.ActionItem id={PANEL_ID} icon={icon} onClick={() => { /* 打开内容区替换 */ }}>{label}</props.protocol.ActionItem>,
)
```

条目典型点击行为：调 `renderPanelContent({ id, render, locale })` 打开自己的内容区替换。

## 3. 内容宽度协议（方案 A，CSS 变量 + localStorage）

面板内容列宽度与官方对话宽度**共用同一契约**，面板自给自足发布，不依赖官方根元素：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `localStorage['dsh.conversation.contentWidth']` | `number`（px） | 拖拽宽度偏好；缺失/损坏 = 无偏好（自适应） |
| `--dsh-conversation-column-width` | `px` | 列宽（ResizeObserver 发布） |
| `--dsh-chat-user-width` | `px` | 拖拽偏好（拖动中实时写入；无偏好时 CSS 回退自适应） |
| `--dsh-chat-content-width` | `px` | 内容列实际宽度（`var(--dsh-chat-user-width, clamp(680px, calc(var(--dsh-conversation-column-width, 0px) * .64), 920px))`） |
| `--dsh-width-handle-pointer-y` | `px` | 手柄 hover 发光条跟随指针的 Y |

约束：内容宽 `[640, column-176]`（两侧各留 88px 放手柄）；无偏好自适应
`clamp(680px, column * .64, 920px)`。

任何插件可读写这些变量实现一致的宽度体验；偏好互操作是有意产品一致行为。
`resetPanelWidth()` 可一键清除。

## 4. 降级与兼容

- **rc.2 ↔ alpha 双版本**：全部新增为「可选字段 / 能力探测 / 自实现镜像」，既有
  方法（`ActionItem` / `renderPanelContent` / `closePanelContent`）与消费方零破坏；
- **会话区承载槽双候选**（`0.1.5-rc.1` 回归）：`0.1.5-rc.1` 把会话区并入
  `main` keyed 槽、删除旧 `conversation` 槽。宿主同时 `inject` 两个候选
  （`conversation` 单槽 + `main`/`conversation` keyed 条目），按核心实际声明择一
  生效；只注册旧槽会导致 inject 回调永不执行 → 面板内容区不替换，只剩侧栏条目
  选中样式；
- **旧 WebView**（无 ResizeObserver / PointerEvent / rAF）：`supported=false`，
  手柄不渲染、宽度固定（`--dsh-chat-content-width` 回退 `780px`），仅 console.warn 一次；
- **renderer 补丁缺失**：`<SlotOutlet>` 为 `undefined` → 侧栏面板整体不注册
  （官方侧栏原样工作），但 `panel.protocol`（内容区替换）仍可用。

## 5. 纯 Web 插件的 DOM 兼容锚点（`PANEL_SIDEBAR_COMPAT_CLASS`）

桌面端以 `priority: -1` 整槽替换官方 `ui-sidebar`，官方 `SidebarRoot`（含
`logoRow` / `newSession` 等 CSS module camelCase class）不再渲染。纯 Web 生态插件
（dsh-web 的 `dsh-task-board` / `dsh-ssh` 等）**不接入**本协议的
`sidebar.panel.action` 槽，而是按官方 class 的 camelCase 子串做纯 DOM 注入：

- `[class*="sidebarCol"]`（官方 layout 列；桌面仍在）定位侧栏列；
- 列内 `[class*="logoRow"]` 元素的 `parentElement` 作为注入 root；
- root 内 `button[class*="newSession"]` 作为「新会话块」定位；
- 入口行插入该块与 workspace 浏览器之间（`closest('[class*="logoRow"]')`
  命中块 → 块是 root 直接子级 → 插到块之后）。

克隆侧栏 class 为 kebab 命名（`dshp-panel__logo-row` 等），与 camelCase 子串
不匹配 → 这类插件的入口行永不挂载（静默，仅 console.error）。为此克隆 DOM 在
**语义等价**元素上携带带官方 camelCase 子串的 token class（无任何样式）：

| token | 值 | 位置（语义） |
| --- | --- | --- |
| `PANEL_SIDEBAR_COMPAT_CLASS.logoRow` | `dshp-panel-compat-logoRow` | 面板区容器 `dshp-panel__panel-area`（充当「新会话所在块」） |
| `PANEL_SIDEBAR_COMPAT_CLASS.newSession` | `dshp-panel-compat-newSession` | 面板区内新会话菜单项（`dshp-panel__new-session`） |

效果：注入行落入 panel-area（新会话 + 第三方条目）与 region-area（workspace
浏览器）之间，与官方侧栏语义等价；`sidebar.panel.action` 协议仍是推荐接入方式，
DOM 锚点仅为无法改造的纯 Web 插件提供回退。未来若克隆侧栏结构调整，须保持
panel-area 为 root 直接子级且 newSession token 位于 logoRow token 容器内
（`closest` 链依赖此几何）。
