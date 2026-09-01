# dsh-tauri-panel

`dsh-tauri-panel` 是 Tauri 桌面端面板能力的扩展入口。当前版本提供稳定的插件包结构、客户端注入点与**内容区宽度拖拽**（方案 A，与 alpha 官方对话宽度协议一致）。

## 能力

- **整槽替换 sidebar**（priority -1 shadow 官方 `ui-sidebar`）：紧凑 logoRow + 面板区（新会话 + 第三方功能项）+ 官方子槽透传（`<SlotOutlet>`，无 renderer 补丁时整体降级不注册）。
- **内容区替换**：以 `priority: -1` 动态注册 `conversation` 槽 → 面板视图替换官方对话区；`panel.protocol` 提供 `ActionItem` / `renderPanelContent` / `closePanelContent`。
- **内容宽度拖拽**：内容列左右对称 `data-width-handle` 手柄（pointer capture + rAF 节流 + 外向 2× 位移），偏好持久化 `localStorage['dsh.conversation.contentWidth']`，与官方共用同一 CSS 变量协议（`--dsh-chat-content-width` / `--dsh-chat-user-width` / `--dsh-conversation-column-width`），rc.2 / alpha 双版本兼容、自给自足发布。
- **协议可选能力**（方案 C）：`setPanelWidth` / `resetPanelWidth` / `getPanelWidth` / `openDetails` / `closeDetails`，消费方 `?.()` 探测调用。

## 面板协议

完整契约见 [`PROTOCOL.md`](./PROTOCOL.md)。快速面：

- 客户端注册 `sidebar.panel.action` 槽，并经反射服务 `panel.protocol` 获取宿主 API：
  - `ActionItem`：统一的侧栏面板条目。
  - `renderPanelContent(spec)`：切换面板内容与官方会话内容。
  - `closePanelContent()`：显式恢复官方会话内容。
  - `setPanelWidth?.(px)` / `resetPanelWidth?.()` / `getPanelWidth?.()`：内容宽度程序化控制。
  - `openDetails?.()` / `closeDetails?.()`：右侧 details 列开关（透传 `ctx.layout`）。

## 相关包

- [`dsh-tauri-ui`](../dsh-tauri-ui)：通用桌面 UI。
- [`dsh-tauri-panel-placeholder`](../dsh-tauri-panel-placeholder)：占位实现。
- [`dsh-tauri-panel-extension`](../dsh-tauri-panel-extension)：扩展面板（技能 / MCP）。
