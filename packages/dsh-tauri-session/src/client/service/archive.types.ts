import type { ActionResult } from '../apis/index.type'

/** 变更后的宿主镜像重拉（工作区浏览器 / 会话列表），由组件侧装配。 */
export type Resync = () => Promise<void>

export type ActionOutcome = ActionResult
