/**
 * host/constants/index.ts — 宿主侧私有常量（跨 half 协议常量见 shared/constants.ts）。
 */

/** 插件状态目录名（位于 DSH_HOME 下）。 */
export const SCHEDULER_STATE_DIRECTORY = 'dsh-tauri-panel-scheduler'

/** tasks/runs 持久化键（unstorage key，`:` 为子目录分隔符）。 */
export const TASKS_KEY = 'tasks.json'
export const RUNS_KEY = 'runs.json'

/** 执行记录保留上限（超出裁剪最旧记录）。 */
export const RUNS_HISTORY_LIMIT = 200

/** 调度引擎 tick 间隔（毫秒）：宿主进程内自建定时器轮询到期任务。 */
export const SCHEDULER_TICK_MS = 1_000

/** 同一任务并发运行保护：运行中则跳过本次触发。 */
export const MAX_CONCURRENT_RUNS = 4

/** 任务指令长度上限（与 DSH 消息体一致的安全边界）。 */
export const PROMPT_MAX_LENGTH = 64_000
export const NAME_MAX_LENGTH = 120
