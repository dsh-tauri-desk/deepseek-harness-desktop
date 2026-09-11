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
 * 播放状态是否循环。
 * - idle/running/moving-*\/dragging：常驻循环（手势期间持续直到结束）；
 * - 细分工作状态档位 thinking/working/result/waiting：非终态档，常驻循环播动画
 *   （对齐 dsh-pet workStatusTick 语义：等用户/干活期间动画不自动结束）；
 * - 终态档 success/error 与 review/failed：播一次后回落（气泡收尾由 use-bubble 管理）。
 */
export function isLoopingAnimation(activity: string): boolean {
  return activity === 'idle' || activity === 'running'
    || activity === 'thinking' || activity === 'working' || activity === 'result' || activity === 'waiting'
    || activity === 'moving-left' || activity === 'moving-right'
    || activity === 'dragging'
}

/**
 * 自定义 Codex v2 图集没有细分档位行（固定 8×11，无思考/工作/整理/庆祝行）：
 * 细分档播放时近似映射到既有行，避免播到错误 sprite（保留会话状态近似观感）。
 */
export function spriteStatusFallback(activity: string): string {
  return activity === 'thinking'
    ? 'waiting'
    : activity === 'working'
      ? 'running'
      : activity === 'result'
        ? 'review'
        : activity === 'success'
          ? 'waving'
          : activity === 'error'
            ? 'failed'
            : activity
}

/** 从字符串池等概率抽一个；exclude 排除某个名字（避免连续重复）。 */
export function pick<T>(pool: readonly T[], exclude?: T): T {
  const entries = exclude === undefined ? pool : pool.filter(item => item !== exclude)
  // 排除后池空（单元素池 + 排除自己）：退回原池抽——宁可重复，也不要返回 undefined
  const source = entries.length > 0 ? entries : pool
  return source[Math.floor(Math.random() * source.length)] ?? source[0]
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
): { id: string, name: string } {
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
 * 两族状态：
 * 1. 细分工作状态档位（workStatus，host reducer 输出）：thinking/working/result/
 *    waiting/success/error，对齐 dsh-pet config.jsonc animations.events.workStatus
 *    数组（索引即档位）——turn/start→thinking、tool/call→working、tool/result→result、
 *    approval/asked 等→waiting、turn/end completed→success、error/max-tokens→error。
 *    这些档位优先映射到工作状态系列动画（思考冒泡/忙碌点按/清点归档/踱步张望/
 *    雀跃庆祝/垂头叹气冒汗，e1ff8c1 起的新预设资产）。
 * 2. 旧粗态兼容（无细分档的会话展示路径）：running 写代码、review 轻快记录、
 *    failed 玩游戏气急败坏、bubble 鲸鱼吐泡泡特效。
 * 资产缺失时 resolvePresetName 仍返回 null：会话状态（override/props 驱动）由调用方
 * 走 fallbackPresetName 降级（避免卡在旧循环），adHoc（点击回应/待机插播）保持当前动画。
 */
export const PRESET_SESSION_ANIMATIONS: Record<string, string> = {
  // 细分工作状态档位（workStatus）
  thinking: '工作状态-思考冒泡',
  working: '工作状态-忙碌点按',
  result: '工作状态-清点归档',
  waiting: '工作状态-原地踱步张望',
  success: '工作状态-雀跃庆祝',
  error: '工作状态-垂头叹气冒汗',
  // 旧粗态兼容
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
  return assets[name] !== undefined ? name : null
}

/**
 * 会话状态解析不到资产时的降级动画名（与 resolvePresetName 的「保持当前动画」
 * 语义互补）：resolve 失败若不切换，宠物会永久卡在上一个循环动画上 —— 典型故障
 * 是细分工作档（thinking/working/result/waiting）资产缺失的旧预设中，会话运行
 * 显示待机、拖拽结束后永远循环拖拽动画。
 *
 * 降级链：
 * 1. 细分工作档/粗态 running → 粗态「写代码」（旧预设普遍存在，保留「在干活」
 *    的观感，而非退回待机）；
 * 2. 其余状态（终态档/待机链）→ 待机池兜底；
 * 3. 无可播资产时返回 null（调用方保持当前动画）。
 *
 * 仅用于会话状态（override/props 驱动）；adHoc（点击回应/待机插播）缺失时
 * 仍保持当前动画 —— 一次性风味动画不应被错播成工作/待机动画。
 */
export function fallbackPresetName(
  activity: string,
  pools: { idlePool: readonly string[] },
  assets: Record<string, string>,
): string | null {
  if (activity === 'thinking' || activity === 'working'
    || activity === 'result' || activity === 'waiting' || activity === 'running') {
    const running = PRESET_SESSION_ANIMATIONS.running
    if (running !== undefined && assets[running] !== undefined)
      return running
  }
  if (pools.idlePool.length > 0) {
    const name = pick(pools.idlePool)
    if (assets[name] !== undefined)
      return name
  }
  return null
}

/**
 * 动画播放目标：真正决定「播放哪个媒体、怎么播」的三要素。
 * - src：解析后的动画资源 URL（不是动画名——切换宠物时同名动画的 URL 不同，必须重载）；
 * - once：一次性/循环语义（决定视频 loop 与 ended 回落）；
 * - seq：显式重播序号（点击回应等 adHoc 每触发一次就递增，对应 dsh-pet 的 seq 重放）。
 *
 * 会话档位（thinking/working/result/…）刻意【不在】目标里：档位只是解析目标的输入，
 * 不是重播依据。
 */
export interface PetAnimationTarget {
  once: boolean
  seq: number
  src: string
}

/**
 * 是否需要重载视频来切换动画（纯函数，可单测）。
 *
 * 【为什么存在】会话档位反复下发时（同一档位重复到达、或多会话交错让聚合档位在
 * 解析结果相同的动画之间来回切），旧实现按 override.revision 递增重载同一个 webm
 * 并从头播放——用户看到的现象是「气泡信息明明是同一个『整理结果中』，动画却一直
 * 重新播放」。动画是否重播只由播放目标决定：
 * - 目标资源变化（真换了动画 / 换了宠物）→ 重载；
 * - once（循环语义）变化 → 重载，因为要重新设置 video.loop；
 * - seq（点击回应等显式重播）变化 → 重载，用户重新点击就是要再看一次。
 * 三者都不变 = 同一个动画目标，继续播放，不刷新。
 */
export function shouldReloadAnimation(
  previous: PetAnimationTarget | null,
  next: PetAnimationTarget,
): boolean {
  if (previous === null)
    return true
  return previous.src !== next.src
    || previous.once !== next.once
    || previous.seq !== next.seq
}
