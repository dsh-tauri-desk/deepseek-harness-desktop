import type { PetAnimationTarget, PetCategory, PetWeights } from './'
import { describe, expect, it, vi } from 'vitest'
import {
  fallbackPresetName,
  isLoopingAnimation,
  pick,
  pickCategoryAction,
  pickWeightedCategory,
  poolEntryToStatus,
  resolvePresetName,
  rollKind,
  shouldReloadAnimation,
  spriteStatusFallback,
} from './'

const WEIGHTS: PetWeights = { idle: 10, turn: 5, move: 5 }

describe('rollKind', () => {
  it('maps roll ranges to idle/turn/move/action by weights', () => {
    expect(rollKind(0.0, WEIGHTS)).toBe('idle')
    expect(rollKind(0.0999, WEIGHTS)).toBe('idle')
    expect(rollKind(0.10, WEIGHTS)).toBe('turn')
    expect(rollKind(0.1499, WEIGHTS)).toBe('turn')
    expect(rollKind(0.15, WEIGHTS)).toBe('move')
    expect(rollKind(0.1999, WEIGHTS)).toBe('move')
    // topEnd = (10+5+5)/100 = 0.20，剩余 0.20~1.00 全归 action
    expect(rollKind(0.20, WEIGHTS)).toBe('action')
    expect(rollKind(0.9999, WEIGHTS)).toBe('action')
  })

  it('treats zero-sum weights as always-action', () => {
    expect(rollKind(0.0, { idle: 0, turn: 0, move: 0 })).toBe('action')
    expect(rollKind(0.9, { idle: 0, turn: 0, move: 0 })).toBe('action')
  })
})

describe('pickWeightedCategory', () => {
  const categories: PetCategory[] = [
    { id: '小动作', weight: 20, actions: ['wave', 'bubble'] },
    { id: '玩耍', weight: 20, actions: ['turn'] },
    { id: '文字', weight: 10, noMirror: true, actions: ['waiting'] },
  ]

  it('excludes noMirror categories while facing right', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95)
    const left = pickWeightedCategory(categories, 'left')
    const right = pickWeightedCategory(categories, 'right')
    // facing=right 时 noMirror 分类被排除，抽取结果只剩前两个分类
    expect(['小动作', '玩耍', '文字']).toContain(left?.id)
    expect(['小动作', '玩耍']).toContain(right?.id)
    expect(right?.id).not.toBe('文字')
    vi.restoreAllMocks()
  })

  it('skips categories without actions and returns null for empty pools', () => {
    expect(pickWeightedCategory([], 'left')).toBeNull()
    expect(pickWeightedCategory([{ id: '空', weight: 1, actions: [] }], 'left')).toBeNull()
  })
})

describe('pickCategoryAction', () => {
  it('picks an action from a weighted category', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    const result = pickCategoryAction(
      [{ id: '小动作', weight: 1, actions: ['wave', 'bubble'] }],
      ['idle'],
      'left',
      'idle',
    )
    expect(result.id).toBe('小动作')
    expect(result.name).toBe('wave')
    vi.restoreAllMocks()
  })

  it('falls back to the idle pool when no category is available', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const result = pickCategoryAction([], ['idle', 'turn'], 'left', 'idle')
    expect(result.id).toBe('FALLBACK')
    expect(['idle', 'turn']).toContain(result.name)
    vi.restoreAllMocks()
  })
})

describe('pick', () => {
  it('picks from a pool and avoids the excluded entry when possible', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    expect(pick(['a', 'b'], 'a')).toBe('b')
    vi.restoreAllMocks()
  })

  it('falls back to the original pool when exclusion empties it', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    expect(pick(['a'], 'a')).toBe('a')
    vi.restoreAllMocks()
  })
})

describe('poolEntryToStatus', () => {
  it('normalizes the wave asset key to the waving status', () => {
    expect(poolEntryToStatus('wave')).toBe('waving')
    expect(poolEntryToStatus('idle')).toBe('idle')
    expect(poolEntryToStatus('bubble')).toBe('bubble')
    expect(poolEntryToStatus('turn')).toBe('turn')
  })
})

describe('resolvePresetName', () => {
  const pools = {
    idlePool: ['待机呼吸休闲'],
    turnPool: ['东张西望'],
    dragPool: ['被鼠标拖拽悬空反馈'],
    clicksPool: ['点击回应-开心跃动', '点击回应-元气挥手'],
  } as const
  const assets: Record<string, string> = {
    '待机呼吸休闲': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E5%BE%85.webm',
    '东张西望': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E4%B8%9C.webm',
    '被鼠标拖拽悬空反馈': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E8%A2%AB.webm',
    '点击回应-开心跃动': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E5%BC%80.webm',
    // DSH 细分工作状态档位叠加映射名（e1ff8c1 起的 6 个新 webm）
    '工作状态-思考冒泡': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E6%80%9D.webm',
    '工作状态-忙碌点按': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E5%BF%99.webm',
    '工作状态-清点归档': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E6%B8%85.webm',
    '工作状态-原地踱步张望': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E8%B8%B1.webm',
    '工作状态-雀跃庆祝': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E9%9B%80.webm',
    '工作状态-垂头叹气冒汗': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E5%9E%82.webm',
    // 旧粗态兼容映射名
    '写代码': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E5%86%99.webm',
    '轻快记录': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E8%BD%BB.webm',
    '玩游戏气急败坏': 'dsh-pet://localhost/maid-deepseek-whale/webm/%E6%B0%94.webm',
  }

  it('returns the asset name directly when activity is already a playable name', () => {
    expect(resolvePresetName('待机呼吸休闲', pools, assets)).toBe('待机呼吸休闲')
    expect(resolvePresetName('点击回应-开心跃动', pools, assets)).toBe('点击回应-开心跃动')
  })

  it('maps statuses to their protocol pools', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    expect(resolvePresetName('idle', pools, assets)).toBe('待机呼吸休闲')
    expect(resolvePresetName('turn', pools, assets)).toBe('东张西望')
    expect(resolvePresetName('dragging', pools, assets)).toBe('被鼠标拖拽悬空反馈')
    expect(resolvePresetName('waving', pools, assets)).toBe('点击回应-开心跃动')
    vi.restoreAllMocks()
  })

  it('maps session statuses to the DSH overlay animation names', () => {
    // 细分工作状态档位（e1ff8c1 起的 6 个新 webm）
    expect(resolvePresetName('thinking', pools, assets)).toBe('工作状态-思考冒泡')
    expect(resolvePresetName('working', pools, assets)).toBe('工作状态-忙碌点按')
    expect(resolvePresetName('result', pools, assets)).toBe('工作状态-清点归档')
    expect(resolvePresetName('waiting', pools, assets)).toBe('工作状态-原地踱步张望')
    expect(resolvePresetName('success', pools, assets)).toBe('工作状态-雀跃庆祝')
    expect(resolvePresetName('error', pools, assets)).toBe('工作状态-垂头叹气冒汗')
    // 旧粗态兼容映射
    expect(resolvePresetName('running', pools, assets)).toBe('写代码')
    expect(resolvePresetName('review', pools, assets)).toBe('轻快记录')
    expect(resolvePresetName('failed', pools, assets)).toBe('玩游戏气急败坏')
  })

  it('isLoopingAnimation：细分非终态档与 idle/running 循环，终态档与 review/failed 播一次', () => {
    expect(isLoopingAnimation('idle')).toBe(true)
    expect(isLoopingAnimation('thinking')).toBe(true)
    expect(isLoopingAnimation('working')).toBe(true)
    expect(isLoopingAnimation('result')).toBe(true)
    expect(isLoopingAnimation('waiting')).toBe(true)
    expect(isLoopingAnimation('running')).toBe(true)
    expect(isLoopingAnimation('success')).toBe(false)
    expect(isLoopingAnimation('error')).toBe(false)
    expect(isLoopingAnimation('review')).toBe(false)
    expect(isLoopingAnimation('failed')).toBe(false)
    expect(isLoopingAnimation('waving')).toBe(false)
  })

  it('spriteStatusFallback：自定义图集无细分档行，近似映射到既有行', () => {
    expect(spriteStatusFallback('thinking')).toBe('waiting')
    expect(spriteStatusFallback('working')).toBe('running')
    expect(spriteStatusFallback('result')).toBe('review')
    expect(spriteStatusFallback('success')).toBe('waving')
    expect(spriteStatusFallback('error')).toBe('failed')
    expect(spriteStatusFallback('idle')).toBe('idle')
    expect(spriteStatusFallback('running')).toBe('running')
  })

  it('returns null for session statuses whose overlay asset is missing', () => {
    const partial: Record<string, string> = { 待机呼吸休闲: 'x.webm' }
    expect(resolvePresetName('running', pools, partial)).toBeNull()
    expect(resolvePresetName('bubble', pools, partial)).toBeNull()
  })

  it('returns null when the pool entry is not backed by an asset', () => {
    expect(resolvePresetName('idle', { ...pools, idlePool: ['不存在.webm'] }, assets)).toBeNull()
    expect(resolvePresetName('idle', { ...pools, idlePool: [] }, assets)).toBeNull()
  })
})

describe('shouldReloadAnimation', () => {
  const thinking: PetAnimationTarget = {
    once: false,
    seq: 0,
    src: 'dsh-pet://localhost/maid-deepseek-whale/webm/%E6%80%9D.webm',
  }

  it('首次下发（无已播放目标）必须加载', () => {
    expect(shouldReloadAnimation(null, thinking)).toBe(true)
  })

  it('同一状态重复下发解析到同一目标时不重载（动画不重新播放）', () => {
    // 会话档位「整理结果中」连续两次（或聚合档位来回切到同一解析结果）：
    // 资源/循环语义/重播序号都不变 → 继续播放，不从头重播。
    expect(shouldReloadAnimation(thinking, { ...thinking })).toBe(false)
  })

  it('目标动画变化时重载', () => {
    const result: PetAnimationTarget = {
      once: false,
      seq: 0,
      src: 'dsh-pet://localhost/maid-deepseek-whale/webm/%E6%B8%85.webm',
    }
    expect(shouldReloadAnimation(thinking, result)).toBe(true)
  })

  it('同名动画但资源 URL 不同（切换宠物）必须重载', () => {
    const other: PetAnimationTarget = {
      ...thinking,
      src: 'dsh-pet://localhost/other-pet/webm/%E6%80%9D.webm',
    }
    expect(shouldReloadAnimation(thinking, other)).toBe(true)
  })

  it('循环语义变化必须重载', () => {
    expect(shouldReloadAnimation(thinking, { ...thinking, once: true })).toBe(true)
  })

  it('显式重播序号变化必须重载（点击同一动画再看一次）', () => {
    expect(shouldReloadAnimation(thinking, { ...thinking, seq: 1 })).toBe(true)
  })
})

describe('fallbackPresetName', () => {
  // 旧预设（e1ff8c1 资产差集前的安装）：无 工作状态-*，但有待机与写代码。
  const stale: Record<string, string> = {
    待机呼吸休闲: 'dsh-pet://localhost/maid-deepseek-whale/webm/idle.webm',
    写代码: 'dsh-pet://localhost/maid-deepseek-whale/webm/code.webm',
  }
  const pools = { idlePool: ['待机呼吸休闲'] } as const

  it('降级细分工作档到粗态写代码（资产缺失时不再卡旧循环）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    expect(fallbackPresetName('thinking', pools, stale)).toBe('写代码')
    expect(fallbackPresetName('working', pools, stale)).toBe('写代码')
    expect(fallbackPresetName('result', pools, stale)).toBe('写代码')
    expect(fallbackPresetName('waiting', pools, stale)).toBe('写代码')
    expect(fallbackPresetName('running', pools, stale)).toBe('写代码')
    vi.restoreAllMocks()
  })

  it('细分档资产存在时无需降级（fallback 只作 resolve 失败的后备）', () => {
    expect(fallbackPresetName('thinking', pools, { '待机呼吸休闲': 'idle.webm', '工作状态-思考冒泡': 'think.webm', '写代码': 'code.webm' })).toBe('写代码')
  })

  it('终态档/其他状态降到待机池', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0)
    expect(fallbackPresetName('success', pools, stale)).toBe('待机呼吸休闲')
    expect(fallbackPresetName('error', pools, stale)).toBe('待机呼吸休闲')
    expect(fallbackPresetName('review', pools, stale)).toBe('待机呼吸休闲')
    expect(fallbackPresetName('failed', pools, stale)).toBe('待机呼吸休闲')
    expect(fallbackPresetName('bubble', pools, stale)).toBe('待机呼吸休闲')
    vi.restoreAllMocks()
  })

  it('待机池也无资产时返回 null（调用方保持当前动画）', () => {
    expect(fallbackPresetName('working', pools, {})).toBeNull()
    expect(fallbackPresetName('working', { idlePool: [] }, {})).toBeNull()
  })
})
