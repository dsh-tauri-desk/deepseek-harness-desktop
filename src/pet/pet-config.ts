/**
 * pet-config.ts — 预设桌宠配置（dsh-pet assets/config.jsonc 协议）的纯逻辑层。
 *
 * 配置由 Rust 从 ~/.dsh/pets/<id>/config.jsonc 读取、剥注释并校验后经
 * `get_preset_pet_config` 命令返回（字段形状 = 子仓库 dsh-pet assets/config.jsonc
 * 协议的受支持子集，动画池条目 = 动画名 = webm 文件名主名）。本模块只做两件事：
 * 1. 类型收敛：把命令返回值声明成可直接消费的结构；
 * 2. 权重掷骰：移植 dsh-pet src/shared/pickers.ts 的 rollKind / pickWeightedCategory /
 *    pickCategoryAction（DSH 无自动漫游，move 档由调用方决定保持待机，不在本模块移动窗口），
 *    以及按播放状态解析实际动画名（resolvePresetName）。
 * 无 React / DOM / Tauri 依赖，可独立单测。
 */

/** 动画链掷骰结果类别。 */
export type PetRollKind = 'idle' | 'turn' | 'move' | 'action'

/** 动画链顶层权重（idle/turn/move，协议字段 animationWeights）。 */
export interface PetWeights {
  idle: number
  turn: number
  move: number
}

/** 随机动作分类（带文字、镜像会颠倒的池带 noMirror）。 */
export interface PetCategory {
  id: string
  weight: number
  noMirror?: boolean
  actions: string[]
}

/** 移动池（DSH 不自动移动窗口，仅保留协议字段供未来对齐）。 */
export interface PetMovesConfig {
  default: Record<string, number>
  actions: { name: string, params?: Record<string, number> }[]
}

/** config.jsonc 的 animations 段（协议子集）。 */
export interface PetAnimationsConfig {
  idle: string[]
  turn: string[]
  drag: string[]
  clicks: string[]
  moves: PetMovesConfig
  categories: PetCategory[]
  events?: Record<string, string[]>
}

/** config.jsonc 全集（受支持子集；pets/physics/eventsRefreshSec 由 Rust 校验）。 */
export interface PetConfig {
  pets: { id: string, name?: string, size?: number }[]
  animations: PetAnimationsConfig
  animationWeights: PetWeights
  physics?: Record<string, unknown>
  eventsRefreshSec?: Record<string, number>
}

/**
 * 从字符串池等概率抽一个；exclude 排除某个名字（避免连续重复）。
 * 池为空时返回 undefined（Rust 侧 `validate_preset_pool_entries` 明确允许空池，
 * 由调用方决定回落策略），签名如实反映这一点。
 */
export function pick<T>(pool: readonly T[], exclude?: T): T | undefined {
  const entries = exclude === undefined ? pool : pool.filter(item => item !== exclude)
  // 排除后池空（单元素池 + 排除自己）：退回原池抽——宁可重复，也不要返回 undefined
  const source = entries.length > 0 ? entries : pool
  if (source.length === 0)
    return undefined
  return source[Math.floor(Math.random() * source.length)]
}

/**
 * 按权重掷骰：roll ∈ [0,1) → 下一个动画类别（纯函数，可单测）。
 * topEnd = (idle+turn+move)/100：三档权重占比之和，剩余概率归入 'action'。
 */
export function rollKind(roll: number, weights: PetWeights): PetRollKind {
  const total = weights.idle + weights.turn + weights.move
  if (total <= 0)
    return 'action'
  const topEnd = total / 100
  if (roll < weights.idle / 100)
    return 'idle'
  if (roll < (weights.idle + weights.turn) / 100)
    return 'turn'
  if (roll < topEnd)
    return 'move'
  return 'action'
}

/**
 * 按权重在分类池中选一个分类；noMirror 分类在镜像(facing=right)时被排除，
 * 剩余权重自动归一化。分类池为空时返回 null。
 */
export function pickWeightedCategory(categories: PetCategory[], facing: 'left' | 'right'): PetCategory | null {
  const cats = categories.filter(category => category.actions.length > 0)
  if (cats.length === 0)
    return null
  const filtered = cats.filter(category => !(category.noMirror === true && facing === 'right'))
  const eligible = filtered.length > 0 ? filtered : cats
  const totalWeight = eligible.reduce((sum, category) => sum + Math.max(0, category.weight), 0) || 1
  let target = Math.random() * totalWeight
  for (const category of eligible) {
    target -= Math.max(0, category.weight)
    if (target <= 0)
      return category
  }
  return eligible[eligible.length - 1]
}

/** 从分类池选一个动作；无可用分类时回退 idle 池（返回 {id, name}，纯函数）。 */
export function pickCategoryAction(
  categories: PetCategory[],
  idlePool: readonly string[],
  facing: 'left' | 'right',
  current: string,
): { id: string, name: string | undefined } {
  const category = pickWeightedCategory(categories, facing)
  if (category === null)
    return { id: 'FALLBACK', name: pick(idlePool, current) }
  return { id: category.id, name: pick(category.actions, current) }
}

/**
 * 把动画池条目（内置资产键）映射为播放状态：唯一需要归一化的是点击/分类池里的
 * 'wave'（资产键）→ 'waving'（播放状态）；其余键与播放状态同名。
 */
export function poolEntryToStatus(entry: string): string {
  return entry === 'wave' ? 'waving' : entry
}

/**
 * DSH 会话状态 → dsh-pet 动画名（webm 文件名主名）的叠加映射。
 *
 * dsh-pet 协议（config.jsonc）只有 idle/turn/drag/clicks/moves/categories/events 池，
 * 没有 waiting/running/review/failed/bubble 这些 DSH 会话状态的对应池。这些动画文件
 * 在预设资产里真实存在（与旧内置 maid-*.webm 按字节一一对应，见 pet.todo.md 4.0），
 * 由本表把会话状态映射到具体文件名：running 循环写代码、waiting 深度思考碎碎念、
 * review 轻快记录、failed 玩游戏气急败坏、bubble 鲸鱼吐泡泡特效。
 * 资产缺失时 resolvePresetName 仍返回 null（调用方保持当前动画，不做静默兜底）。
 */
export const PRESET_SESSION_ANIMATIONS: Record<string, string> = {
  waiting: '深度思考碎碎念',
  running: '写代码',
  review: '轻快记录',
  failed: '玩游戏气急败坏',
  bubble: '鲸鱼吐泡泡特效',
}

/**
 * 预设宠物：把播放状态解析为实际动画名（webm 文件名主名，如 待机呼吸休闲）。
 * - 活动名本身就是可播放动画名（adHoc 池条目 / 会话状态映射名）时直接命中资产；
 * - 会话状态（waiting/running/review/failed/bubble）经 PRESET_SESSION_ANIMATIONS
 *   叠加映射到具体动画名；映射名没有对应资产时返回 null（保持当前动画）；
 * - 状态档（idle/dragging/turn/waving）从对应池等概率抽一个名字。
 */
export function resolvePresetName(
  activity: string,
  pools: {
    idlePool: readonly string[]
    turnPool: readonly string[]
    dragPool: readonly string[]
    clicksPool: readonly string[]
  },
  assets: Record<string, string>,
): string | null {
  if (assets[activity] !== undefined)
    return activity
  const sessionName = PRESET_SESSION_ANIMATIONS[activity]
  if (sessionName !== undefined && assets[sessionName] !== undefined)
    return sessionName
  const pool = activity === 'idle'
    ? pools.idlePool
    : activity === 'dragging'
      ? pools.dragPool
      : activity === 'turn'
        ? pools.turnPool
        : activity === 'waving'
          ? pools.clicksPool
          : null
  if (pool === null || pool.length === 0)
    return null
  const name = pick(pool)
  if (name === undefined)
    return null
  return assets[name] !== undefined ? name : null
}
