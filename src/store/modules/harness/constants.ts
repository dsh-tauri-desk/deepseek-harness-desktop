/**
 * 服务生命周期与健康检查的时序常量（毫秒）。
 *
 * 集中一处：启动/插件安装/页面加载各自有「无活动」与「绝对」双上限，
 * 调参时需要在同一屏内对照，散落在 actions 之间极易改漏。
 */

/** iframe 挂载后等待 dsh 页面完成加载的兜底上限 */
export const IFRAME_LOAD_TIMEOUT = 20000

/** 健康探测退避区间（1s 起、1.5 倍递增、封顶 5s） */
export const HEALTH_PROBE_INITIAL_INTERVAL = 1000
export const HEALTH_PROBE_MAX_INTERVAL = 5000

/** 服务启动阶段：无活动 / 绝对上限 */
export const STARTUP_INACTIVITY_TIMEOUT = 180000
export const STARTUP_ABSOLUTE_TIMEOUT = 300000

/** 内置插件自愈阶段：无活动 / 绝对上限 */
export const PLUGIN_INACTIVITY_TIMEOUT = 30000
export const PLUGIN_ABSOLUTE_TIMEOUT = 600000
export const PLUGIN_ACTIVITY_CHECK_INTERVAL = 1000

/** iframe 内官方 boot 页失败后的恢复探测上限（远小于完整启动） */
export const IFRAME_RECOVERY_ABSOLUTE_TIMEOUT = 60000

/** 启动失败时从服务日志尾部挑选的原始行上限（ANSI 清洗后按行截断） */
export const LOG_TAIL_MAX_BYTES = 16 * 1024

/** 进入 ready 后 iframe 连续重载的容忍次数（防抖 + 防死循环） */
export const IFRAME_RELOAD_MAX_ATTEMPTS = 3
