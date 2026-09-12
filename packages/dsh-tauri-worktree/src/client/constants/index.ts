/** client/constants.ts — 客户端共享常量（跨 half 协议常量见 shared/constants.ts）。 */

import { WORKTREE_PLUGIN_NAME } from '../../shared/constants'

export { WORKTREE_API_PREFIX, WORKTREE_PLUGIN_NAME } from '../../shared/constants'

export const WORKTREE_LOCALE_NAMESPACE = WORKTREE_PLUGIN_NAME

export const INPUT_DOCK_SLOT = 'conversation.input.dock'
export const SHELL_OVERLAY_SLOT = 'shell.overlay'
export const MODE_SELECT_ID = `${WORKTREE_PLUGIN_NAME}-mode`
export const MODE_SELECT_ORDER = -20
export const SURFACE_ID = `${WORKTREE_PLUGIN_NAME}-surface`
export const SURFACE_ORDER = -10
export const DIALOG_ID = `${WORKTREE_PLUGIN_NAME}-dialog`

export const STYLES_EFFECT = `${WORKTREE_PLUGIN_NAME}: styles`
export const MODE_SELECT_EFFECT = `${WORKTREE_PLUGIN_NAME}: mode select slot`
export const SURFACE_EFFECT = `${WORKTREE_PLUGIN_NAME}: surface slot`
export const DIALOG_EFFECT = `${WORKTREE_PLUGIN_NAME}: dialog`
export const HYDRATION_EFFECT = `${WORKTREE_PLUGIN_NAME}: hydrate session bindings`
export const SESSION_ICONS_EFFECT = `${WORKTREE_PLUGIN_NAME}: session branch icons`

export const SESSION_SWITCH_RETRY_DELAY_MS = 100
export const SESSION_SWITCH_MAX_ATTEMPTS = 30

/** hydration 失败/未知状态的重试间隔与上限（1.5s × 30 ≈ 45s，成功后立即停止）。 */
export const HYDRATION_RETRY_DELAY_MS = 1500
export const HYDRATION_MAX_RETRIES = 30
/**
 * 未解析会话的重试窗口：会话出现在列表后的这段时间内才重试。
 *
 * 宿主返回 `isGit: null` 既可能是启动/新建竞态（数秒内自愈），也可能是**永久**的——
 * 会话列表里长期存在宿主已不再持有的历史会话（实测某个 profile：83 个会话中 77 个永远
 * 解析不出）。窗口外不再重试，避免这批会话把 `/status` 变成永久轮询。
 */
export const HYDRATION_RETRY_WINDOW_MS = 10_000
/**
 * 未解析会话的全局重试配额（次/秒）。
 *
 * 会话可能有几十上百个；若它们各自独立重试，聚合请求量会随会话数线性增长。配额由所有
 * 未解析会话共享，使聚合速率与会话数解耦。
 */
export const HYDRATION_RETRY_BUDGET_PER_SECOND = 8
/**
 * 会话事件流/列表快照触发的状态复核最小间隔。
 *
 * 会话事件流在流式输出期间每秒可通知上百次，列表快照同样随事件更新；不节流时每个
 * 通知都会打一次 `GET /status`（宿主还要为每次请求 fork 一个 git 子进程），把只读
 * 状态查询放大成持续请求风暴。窗口内合并为一次拖尾执行：Agent 调用
 * `checkout_worktree` / `discard_worktree` 后 UI 最迟在该间隔内收敛，不丢状态变化。
 */
export const SESSION_RECONCILE_MIN_INTERVAL_MS = 1200
/** Discard job polling cadence and retry limit. */
export const DISCARD_POLL_DELAY_MS = 500
export const DISCARD_MAX_POLLS = 120

/**
 * create_worktree 自动交接的时效窗口：只有「本次运行期间新出现」且出现不超过该时长的
 * 工作树会话才允许自动打开。启动时已存在的历史工作树、以及用户事后回到源会话的场景
 * 一律不抢焦点（否则点击新建会话会被误跳转到工作树会话）。
 * 60s 覆盖 hydration 的完整重试链（45s），避免慢速首查把真实交接误判为过期。
 */
export const HANDOFF_WINDOW_MS = 60_000

export const MODE_SELECT_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/ModeSelect.module.css'
export const WORKTREE_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/SurfaceDialog.module.css'
export const SURFACE_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/Surface.module.css'
export const DIALOG_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/Dialog.module.css'
export const SESSION_ICON_STYLE_ID = '@deepseek-ai/dsh-tauri-worktree/SessionBranchIcon.module.css'

export const SESSION_ICON_ATTRIBUTE = 'data-dsh-worktree-icon'
export const SIDEBAR_SELECTOR = '[data-slot="sidebar"]'
export const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]'
export const COMPOSER_CARD_SELECTOR = '[data-composer-card="true"]'
export const HERO_PRESET_SLOT_SELECTOR = '[data-slot="conversation.hero.agentPreset"]'
/** 输入条内的「规划」计划槽位，用于定位访问模式右侧的 .modes 分组（见 utils/worktree.ts）。 */
export const COMPOSER_PLAN_SLOT_SELECTOR = '[data-slot="conversation.input.plan"]'
/**
 * rc.2/alpha 共用的稳定「访问模式」按钮定位。aria-label 由官方
 * input.accessMode 文案提供（`.uV2eYG_modes` 是生成 hash，绝不依赖）。
 * 模式选择器始终锚到此按钮右侧的 .modes 分组，而非 hero 的 Agent 预设槽位。
 */
export const COMPOSER_MODE_BUTTON_SELECTOR = `${COMPOSER_CARD_SELECTOR} button[aria-label*="访问模式"], ${COMPOSER_CARD_SELECTOR} button[aria-label*="Access mode"]`
export const MODE_ANCHOR_ATTRIBUTE = 'data-dsh-tauri-worktree-mode-anchor'
