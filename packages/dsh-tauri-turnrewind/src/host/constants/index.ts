/**
 * host/constants/index.ts — 宿主侧私有常量。
 *
 * 上限与错误码集中在此：捕获路径、撤销路径与容量治理共用同一组判定，
 * 避免「预览说超限、执行却照做」这类双份常量漂移。
 */

import { TURNREWIND_PLUGIN_NAME, TURNREWIND_REASON_GIT_REQUIRED, TURNREWIND_REASON_SNAPSHOT_FAILED } from '../../shared/constants'

export { TURNREWIND_API_PREFIX, TURNREWIND_PLUGIN_NAME } from '../../shared/constants'

/** 私有快照仓中快照 ref 的命名空间前缀。 */
export const SNAPSHOT_REF_PREFIX = 'refs/turnrewind'

/** 每个工作区私有快照仓的存放目录（DSH_HOME 下）。 */
export const SNAPSHOT_FEATURE_DIR = TURNREWIND_PLUGIN_NAME

/** 账本文件版本；字段或折叠语义变更时递增。 */
export const LEDGER_VERSION = 1

/**
 * 保留为「可撤销」的最近 turn 数；更老的 turn 标记过期（保留审计行、删除 refs）。
 * 与归档版 DEFAULT_RETAIN_TURNS 取同一量级：覆盖用户实际会回看的范围。
 */
export const MAX_TURNS_PER_SESSION = 50

/**
 * 每会话账本行的硬上限（审计窗口）。超过即丢弃最老的行使账本与 summary 载荷有界；
 * 过期行会清空 `files`（只留计数），所以 200 行的载荷仍是 KB 级。
 */
export const MAX_TURN_RECORDS = 200

/**
 * 单个文件超过此字节数即从快照中**排除并在记录里标注**（不是让整轮不可撤销）。
 *
 * 我们恢复走 `git checkout` 流式写盘、不把 blob 读进内存，所以这条不是内存上限，
 * 而是「不让一个巨大的构建产物把私有仓撑爆、并把该工作区的撤销能力整体拖死」。
 * 体积的真正闸门仍是下面的聚合上限。
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

/** 单次快照的聚合字节上限；超过则该 turn 记 unavailable。 */
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024

/** 单 turn 允许纳入快照的最大文件数；超过即该 turn 记 unavailable。 */
export const MAX_FILES_PER_SNAPSHOT = 5000

/** 一次预扫最多排除多少个超限文件；超过则该 turn 记 unavailable（避免 argv 爆炸）。 */
export const MAX_OVERSIZED_SKIPS = 200

/** 私有快照仓容量上限（MB）；超过即整仓隔离重建（旧 turn 全部转过期）。 */
export const MAX_SNAPSHOT_REPO_MB = 2048

/** 单条 git 子进程的墙钟超时（快照/恢复等重活）。 */
export const GIT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 资格探测的墙钟超时：探测结果要喂给 `agent/pre-step` 的执行屏障，
 * 用重活预算（5 分钟）会让一个卡住的 git 把整个 turn 拖住。
 */
export const GIT_PROBE_TIMEOUT_MS = 30 * 1000

/** 工作区解析结果缓存 TTL（冷未命中才同步探测，过期先回缓存值再后台刷新）。 */
export const WORKSPACE_CACHE_TTL_MS = 60 * 1000

/** 工作区解析缓存的条目上限。 */
export const WORKSPACE_CACHE_MAX = 64

/** 摘要路由返回给客户端的文件明细上限（更大的会话只给汇总与截断标记）。 */
export const MAX_SUMMARY_FILES = 200

/**
 * 运行中实时读数的宿主端刷新间隔。宿主定时刷新、客户端只读缓存值：
 * 客户端轮询频率与 git 调用频率解耦，turn 结束后立刻停表。
 */
export const LIVE_POLL_INTERVAL_MS = 1500

/** 会话 cwd 不在 Git worktree 内：不做快照，撤销入口提示需要 Git 仓库。 */
export const REASON_GIT_REQUIRED = TURNREWIND_REASON_GIT_REQUIRED

/** PATH 上没有 git：诊断要与「不是 Git 仓库」区分开（否则用户会去 git init 一个不存在的 git）。 */
export const REASON_GIT_UNAVAILABLE = 'TURNREWIND_GIT_UNAVAILABLE'

/** 会话 cwd 是家目录/家目录祖先/盘根等系统目录：拒绝快照。 */
export const REASON_UNSAFE_WORKSPACE = 'TURNREWIND_UNSAFE_WORKSPACE'

/** 快照文件数超限。 */
export const REASON_TOO_MANY_FILES = 'TURNREWIND_TOO_MANY_FILES'

/** 快照聚合字节超限。 */
export const REASON_SNAPSHOT_TOO_LARGE = 'TURNREWIND_SNAPSHOT_TOO_LARGE'

/** 超限文件太多，无法逐个排除（该轮不提供撤销）。 */
export const REASON_TOO_MANY_OVERSIZED = 'TURNREWIND_TOO_MANY_OVERSIZED'

/** 快照或统计过程失败（git 异常、仓库损坏等）。 */
export const REASON_SNAPSHOT_FAILED = TURNREWIND_REASON_SNAPSHOT_FAILED

/** 快照仓被隔离重建 / 手工删除，该 turn 的 refs 已不存在。 */
export const REASON_EXPIRED = 'TURNREWIND_EXPIRED'

/** 该 turn 的产物已被一次性撤销，不能重复撤销。 */
export const REASON_ALREADY_UNDONE = 'TURNREWIND_ALREADY_UNDONE'

/** 撤销被并发修改拦截。 */
export const REASON_CONFLICT = 'TURNREWIND_CONFLICT'

/** 该 turn 仍在运行中（after 快照未结算），此时撤销没有意义。 */
export const REASON_TURN_ACTIVE = 'TURNREWIND_TURN_ACTIVE'

/** 目标路径的父级是符号链接/junction，撤销拒绝穿透（防路径逃逸）。 */
export const REASON_UNSAFE_PATH = 'TURNREWIND_UNSAFE_PATH'

/** 目标路径当前是非空目录：撤销不递归删除目录。 */
export const REASON_NON_EMPTY_DIR = 'TURNREWIND_NON_EMPTY_DIR'

/** 恢复路径丢失/损坏的 tmp 残骸后缀（崩溃清扫用；我们不写这类文件，仅防御性识别）。 */
export const RESTORE_DEBRIS_SUFFIX = '.turnrewind-restore.bak'
