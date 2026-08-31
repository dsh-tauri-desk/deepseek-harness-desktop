/**
 * `shell.overlay` 条目组件（骨架占位）：定制化 Tauri UI 的渲染落点。
 *
 * shell.overlay 是帧级浮动层（list/root）：位于所有列之上、滚动容器之外，
 * 层本身 click-through，条目自行 opt-in pointer-events。将来桌面风格的自定义
 * chrome（顶部导航/窗口控件/状态胶囊等）在这里渲染；当前骨架不渲染任何
 * 可见内容，仅保证注册链路的类型合约完整可编译。
 *
 * 类型说明：register 的组件须满足 SlotComponent 合约（参数为四份合成 props，
 * 返回 ReactNode）。此处零参数、返回 null 亦合法（参数逆变 + 返回值是
 * ReactNode 子集）；接入真实 UI 后改为消费 props 的常规函数组件即可。
 */
export function TauriUiSeat(): null {
  return null
}
