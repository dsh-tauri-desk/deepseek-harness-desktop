/**
 * client/constants/index.ts — 客户端静态常量（跨 half 协议常量见 shared/constants.ts）。
 */

import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'

export { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'

/**
 * 完成一轮对话的尾部槽位（chain 型）。
 * 官方 `ui-deliverables` 以默认 priority 0 占用该槽渲染 “Files changed” 行；
 * 本插件以更低的优先级抢先当选，用带撤销能力的变更卡片替换它。
 */
export const TURNREWIND_TURN_TAIL_SLOT = 'conversation.chat.turnTail'

/** chain 选举优先级：低于官方默认 0，保证本插件当选。 */
export const TURNREWIND_TURN_TAIL_PRIORITY = -1

/**
 * 输入框上方独占一行的 dock 槽（list 型、可叠加）：运行中提示条的位置。
 *
 * dock 按 order 升序渲染；官方 `todo`（0）、`goal`（10）、`queue`（20）与工作树横幅（-10）
 * 都在这一槽里。提示条必须压在这些条目之上——它是当前这一轮正在发生的改动读数。
 */
export const TURNREWIND_INPUT_DOCK_SLOT = 'conversation.input.dock'

export const TURNREWIND_RUNNING_CHIP_ID = `${TURNREWIND_PLUGIN_NAME}-running-changes`
export const TURNREWIND_RUNNING_CHIP_ORDER = -30

/** 运行中提示条的客户端轮询间隔；宿主端另有 1.5s 的 git 刷新节奏。 */
export const TURNREWIND_LIVE_POLL_INTERVAL_MS = 1200

/** 卡片与提示条的 css-render style id。 */
export const TURNREWIND_CARD_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/TurnChangesCard.module.css`
export const TURNREWIND_CHIP_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/RunningChangesChip.module.css`
export const TURNREWIND_COUNTS_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/ChangeCounts.module.css`

/** effect 标签（诊断/日志）。 */
export const TURNREWIND_LOCALE_EFFECT = `${TURNREWIND_PLUGIN_NAME}: locale`
export const TURNREWIND_SUMMARY_EFFECT = `${TURNREWIND_PLUGIN_NAME}: summary retry`
export const TURNREWIND_TURN_TAIL_EFFECT = `${TURNREWIND_PLUGIN_NAME}: turn tail`
export const TURNREWIND_RUNNING_CHIP_EFFECT = `${TURNREWIND_PLUGIN_NAME}: running chip`

/**
 * 「应用内右侧边栏」服务名（新内核由 `dsh-client-ui-sidebar-right` 发布）。
 * 只做**运行时探测**（`ctx.reflect.get`），绝不写进 `dsh.client.inject`：
 * 旧内核没有这个服务，声明式依赖会让插件在那边的加载直接失败。
 */
export const TURNREWIND_SIDEBAR_RIGHT_SERVICE = 'sidebarRight'

/** 「右侧边栏页类型注册表」服务名（与 `sidebarRight` 在同一个 effect 里发布）。 */
export const TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE = 'sidebarRightTabs'

/** 右侧边栏「文件树」页类型的 kind（新内核由 `dsh-client-ui-sidebar-files` 注册）。 */
export const TURNREWIND_SIDEBAR_FILES_KIND = 'files'

/** 卡片默认展示的文件行数（其余折叠到「再显示 N 个文件」）。 */
export const TURNREWIND_VISIBLE_FILE_ROWS = 3

/**
 * 「该轮已结束但账本还没有记录」时的重试参数（指数退避：700ms → 1.4s → 2.8s → 5s 封顶，
 * 12 次累计约 50s）。
 *
 * after 快照在 turn/end 之后**后台结算**：先是队列里可能在飞的实时读数，再是 after 自身的
 * `git add --all`。实测大仓库上首次 add 要 6–20s，因此短窗口会让手动停止（用户最想看到
 * 这一轮改了什么）以及首次快照的 turn 永远等不到卡片。退避到 5s 既覆盖慢仓库，
 * 又不会在常见情况下持续打请求——一旦账本出现该轮的记录就立刻停止重试。
 */
export const TURNREWIND_SUMMARY_RETRY_DELAY_MS = 700
export const TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS = 5000
export const TURNREWIND_SUMMARY_MAX_RETRIES = 12

/** 重试调度的检查节拍（由 register 的 controller.interval 承担）。 */
export const TURNREWIND_SUMMARY_TICK_MS = 400
