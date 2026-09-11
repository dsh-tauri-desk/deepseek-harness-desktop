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

/** 卡片、提示条与共享计数的 css-render style id。 */
export const TURNREWIND_CARD_STYLE_ID = `${TURNREWIND_PLUGIN_NAME}/TurnChangesCard.module.css`
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

/**
 * 「右侧边栏页类型注册表」服务名（新内核由 `dsh-client-ui-sidebar-right` 与
 * {@link TURNREWIND_SIDEBAR_RIGHT_SERVICE} 在同一个 effect 里发布）。
 *
 * 与 `sidebarRight` 同样只做运行时探测，绝不进 `inject`：旧内核没有它。
 * 「审核」按钮的判据取**这个注册表里有没有文件树页类型**，而不是「有没有 sidebarRight」——
 * 前者才能保证点击真的能打出内容（见 client/utils/review.ts）。
 */
export const TURNREWIND_SIDEBAR_RIGHT_TABS_SERVICE = 'sidebarRightTabs'

/**
 * 右侧边栏「文件树」页类型的 kind（新内核由 `dsh-client-ui-sidebar-files` 注册）。
 *
 * 「审核」按钮点击后就打开这个页：它画的是会话工作区根目录，用户可以直接逐层翻看本轮
 * 改过哪些文件。旧内核连 `sidebarRightTabs` 都没有，注册表探测直接失败 → 不显示按钮。
 */
export const TURNREWIND_SIDEBAR_FILES_KIND = 'files'

/** 卡片默认展示的文件行数（其余折叠到「再显示 N 个文件」）。 */
export const TURNREWIND_VISIBLE_FILE_ROWS = 3

/**
 * 「该轮已结束但账本还没有记录」时的重试参数（指数退避：700ms → 1.4s → 2.8s → 5s 封顶，
 * 12 次累计约 50s）。
 *
 * after 快照在 turn/end 之后**后台结算**：先是队列里可能在飞的实时读数（每 1.5s 一次
 * `git add --all` + diff），再是 after 自身的 `git add --all`。实测大仓库上首次 add 要
 * 6–20s，因此原先「700ms × 6 ≈ 4.2s」的窗口会让**手动停止**（用户最想看到这一轮改了什么）
 * 以及首次快照的 turn 永远等不到卡片。退避到 5s 既覆盖慢仓库，又不会在常见情况下
 * 持续打请求——一旦账本出现该轮的记录（哪怕文件数为 0）就立刻停止重试。
 */
export const TURNREWIND_SUMMARY_RETRY_DELAY_MS = 700
export const TURNREWIND_SUMMARY_RETRY_MAX_DELAY_MS = 5000
export const TURNREWIND_SUMMARY_MAX_RETRIES = 12

/** 卡片 CSS class 前缀（bem block）。 */
export const TURNREWIND_BLOCK = 'turnrewind'
