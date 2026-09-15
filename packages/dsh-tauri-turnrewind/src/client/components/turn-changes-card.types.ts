import type { Capabilities } from '../service/capabilities.types'

/** 文件打开入口的框架契约（owner props 的 `openFile`）。 */
export type FileOpener = (path: string) => void | Promise<unknown>

/** turnTail owner props（框架派发；用到 turn 号与文件打开回调）。 */
export interface TurnTailOwnerProps {
  turn?: { turn?: number } | undefined
  seq?: number | undefined
  /**
   * 框架提供的文件打开入口（相对路径按会话 cwd 解析）。**两个内核都派发它，但语义不同**：
   * `0.1.5-rc.1` 在应用内右侧边栏打开预览页签，`0.1.2-rc.1` 交给宿主/系统打开该路径。
   * 因此本插件只在**探测到右侧边栏能力**时才调用它。
   */
  openFile?: FileOpener | undefined
}

/** 卡片组件收到的完整 props：owner 份额 + chain `matched` + 注册 inject 份额（含能力快照）。 */
export interface TurnChangesCardProps extends TurnTailOwnerProps {
  matched?: { turn: number } | undefined
  sessionId?: string | undefined
  capabilities?: Capabilities | undefined
}
