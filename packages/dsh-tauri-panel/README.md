# dsh-tauri-panel

`dsh-tauri-panel` 是 Tauri 桌面端面板能力的扩展入口。当前版本提供稳定的插件包结构和客户端注入点，后续面板组件将在此基础上演进。

## 面板协议

客户端注册 `sidebar.panel.action` 槽，并通过反射服务 `panel.protocol` 向面板扩展提供：

- `ActionItem`：统一的侧栏面板条目。
- `renderPanelContent(spec)`：切换面板内容与官方会话内容。
- `closePanelContent()`：显式恢复官方会话内容，适合面板内跳转到会话的动作。

## 相关包

- [`dsh-tauri-ui`](../dsh-tauri-ui)：通用桌面 UI。
- [`dsh-tauri-panel-placeholder`](../dsh-tauri-panel-placeholder)：占位实现。
