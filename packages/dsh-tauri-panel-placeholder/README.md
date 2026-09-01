# dsh-tauri-panel-placeholder

`dsh-tauri-panel-placeholder` 是面板扩展的占位插件。它保留与正式面板包一致的加载形态，适合在开发、演示或等待真实面板实现时使用。

## 当前状态

该包通过 `sidebar.panel.action` 槽注册一个「定时任务」样板条目，并消费宿主
`panel.protocol`（`ActionItem` / `renderPanelContent`）：点击在会话内容区打开占位
内容替换视图。协议类型同步宿主可选能力（`setPanelWidth` / `resetPanelWidth` /
`getPanelWidth` / `openDetails` / `closeDetails`），调用一律 `?.()` 探测。完整契约见
[`dsh-tauri-panel/PROTOCOL.md`](../dsh-tauri-panel/PROTOCOL.md)。

需要真实面板时，请改用 [`dsh-tauri-panel`](../dsh-tauri-panel) 或等待后续实现。
