/**
 * client/constants/index.ts — 客户端共享常量（跨 half 协议常量见 shared/constants.ts）。
 */

import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'

export { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME } from '../../shared/constants'

/** locale 命名空间（与插件名一致）。 */
export const TURNREWIND_LOCALE_NAMESPACE = TURNREWIND_PLUGIN_NAME

/**
 * 完成一轮对话的尾部槽位（chain 型）。
 * 官方 `ui-deliverables` 以默认 priority 0 占用该槽渲染 “Files changed” 行；
 * 本插件以 {@link TURNREWIND_TURN_TAIL_PRIORITY} 抢先当选，用带撤销能力的
 * 变更卡片替换它（需求已确认接受该替换及其后果）。
 */
export const TURNREWIND_TURN_TAIL_SLOT = 'conversation.chat.turnTail'

/** chain 选举优先级：低于官方默认 0，保证本插件当选。 */
export const TURNREWIND_TURN_TAIL_PRIORITY = -1

/** 卡片注册 id（诊断/多注册区分）。 */
export const TURNREWIND_TURN_TAIL_ID = `${TURNREWIND_PLUGIN_NAME}-turn-changes`

/**
 * 输入框上方独占一行的 dock 槽（list 型、可叠加）：运行中提示条的位置。
 * 官方把「运行中」提示放在这里，与 turn 尾部的收尾卡片互不冲突。
 */
export const TURNREWIND_INPUT_DOCK_SLOT = 'conversation.input.dock'

/**
 * 运行中提示条注册 id 与顺序。
 *
 * dock 是 list 型槽，按 `order` 升序自上而下渲染。已核实的其他条目：
 * 官方 `todo`（0，`data-testid="todo-panel"`）、`goal`（10）、`queue`（20），
 * 工作树插件的会话横幅 `.dshp-worktree`（-10）。
 *
 * 提示条必须排在**这些条目之上**（用户反馈：原先 order 20 让它掉到最下面，
 * 被任务清单和工作树横幅压在输入框上方最远处，看起来很奇怪）：它是当前这一轮
 * 正在发生的改动读数，属于「对话的最新一行」，理应紧贴对话内容、先于任务清单。
 * 负值同时留出空间——其余插件再往大 order 上加也不会把它挤下去。
 */
export const TURNREWIND_RUNNING_CHIP_ID = `${TURNREWIND_PLUGIN_NAME}-running-changes`
export const TURNREWIND_RUNNING_CHIP_ORDER = -30

/** 运行中提示条的客户端轮询间隔；宿主端另有 1.5s 的 git 刷新节奏。 */
export const TURNREWIND_LIVE_POLL_INTERVAL_MS = 1200

/** 卡片、弹窗、提示条与共享计数的 css-render style id。 */
export const TURNREWIND_CARD_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/TurnChangesCard.module.css`
export const TURNREWIND_DIALOG_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/GitRequiredDialog.module.css`
export const TURNREWIND_CHIP_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/RunningChangesChip.module.css`
export const TURNREWIND_COUNTS_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/ChangeCounts.module.css`

/** effect 标签（诊断/日志）。 */
export const TURNREWIND_EFFECT_TURN_TAIL = `${TURNREWIND_PLUGIN_NAME}: turn tail slot`
export const TURNREWIND_EFFECT_RUNNING_CHIP = `${TURNREWIND_PLUGIN_NAME}: running chip slot`
export const TURNREWIND_EFFECT_LOCALE = `${TURNREWIND_PLUGIN_NAME}: locale`
export const TURNREWIND_EFFECT_CAPABILITIES = `${TURNREWIND_PLUGIN_NAME}: capabilities`

/**
 * 「应用内右侧边栏」服务名（新内核由 `dsh-client-ui-sidebar-right` 发布）。
 *
 * 只做**运行时探测**（`ctx.reflect.get`），绝不写进 `dsh.client.inject`：
 * 旧内核没有这个服务，声明式依赖会让插件在那边的加载直接失败。
 */
export const TURNREWIND_SIDEBAR_RIGHT_SERVICE = 'sidebarRight'

/** 卡片默认展示的文件行数（其余折叠到「再显示 N 个文件」）。 */
export const TURNREWIND_VISIBLE_FILE_ROWS = 3

/**
 * 「该轮已结束但账本还没有记录」时的重试参数：after 快照在 turn/end 之后
 * 后台结算，卡片可能早于账本落地渲染。约 700ms × 6 ≈ 4.2s 足够覆盖本地 git 操作。
 */
export const TURNREWIND_SUMMARY_RETRY_DELAY_MS = 700
export const TURNREWIND_SUMMARY_MAX_RETRIES = 6

/** 卡片 CSS class 前缀（bem block）。 */
export const TURNREWIND_BLOCK = 'turnrewind'
