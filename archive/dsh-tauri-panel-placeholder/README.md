# dsh-tauri-panel-placeholder

`dsh-tauri-panel-placeholder` 是面板扩展的占位插件。它保留与正式面板包一致的加载形态，适合在开发、演示或等待真实面板实现时使用。

## 当前状态

该包是 [`dsh-tauri-panel`](../dsh-tauri-panel) 面板协议的**最小参考实现**：调用宿主
`panel.protocol.registerPanel({ id, label, render, icon, order, locale })` 一次性
注册「占位符」面板入口（图标 + 内容）。

宿主按核心版本自动择路，本插件无需感知：

- ≥ `0.1.5-rc.1`：宿主代注册官方 `sidebar.panellist`（入口行）+ `main`（内容），
  面板成为**官方全局面板**，选中态由 `ctx.layout.selectPanel` 统一派发；
- ≤ `0.1.2-rc.1`：宿主回退私有 `sidebar.panel.action` 槽 + 会话区替换。

协议未就绪时（宿主过旧）打印警告并跳过注册，不注册任何条目。完整契约见
[`dsh-tauri-panel/PROTOCOL.md`](../dsh-tauri-panel/PROTOCOL.md)。

需要真实面板时，请改用 [`dsh-tauri-panel`](../dsh-tauri-panel) 或等待后续实现。
