/**
 * bubble-copy.test.ts — 桌宠气泡文案纯函数（对齐 dsh-dafeiyu src/status-copy.js）单测。
 *
 * 覆盖：seed 稳定选句（同 seed 恒定、不同 seed 可换句）、分组回落、工具活动分类
 * 文案、taskCopy 句式（对齐 dsh-dafeiyu：正在/继续、动作动词、默认处理「…」）。
 */
import { describe, expect, it } from 'vitest'
import { activityCopy, seedNumber, sessionTitle, statusCopy, taskCopy, toolActivityGroup, UNTITLED_SESSION_TITLE } from './bubble'

describe('seedNumber', () => {
  it('numeric strings resolve to the absolute truncated integer', () => {
    expect(seedNumber('12.9')).toBe(12)
    expect(seedNumber('-7')).toBe(7)
    expect(seedNumber(5)).toBe(5)
  })

  it('non-numeric strings sum char code points (stable per string)', () => {
    expect(seedNumber('abc')).toBe(97 + 98 + 99)
    expect(seedNumber('abc')).toBe(seedNumber('abc'))
    expect(seedNumber(undefined)).toBe(0)
    expect(seedNumber('')).toBe(0)
  })
})

describe('statusCopy', () => {
  it('returns a stable sentence for the same seed within a group', () => {
    const first = statusCopy('thinking', 'session-1')
    expect(statusCopy('thinking', 'session-1')).toBe(first)
  })

  it('picks from known groups only', () => {
    const variants = new Set(['正在分析', '思考中', '整理结果中'])
    expect(variants.has(statusCopy('thinking', 0))).toBe(true)
    expect(variants.has(statusCopy('thinking', 1))).toBe(true)
  })

  it('falls back to the working group for unknown groups', () => {
    expect(['正在处理任务', '步骤正在进行中', '系统运行中']).toContain(statusCopy('unknown-group', 0))
  })
})

describe('activityCopy', () => {
  it('maps activity categories to their copy groups', () => {
    expect(['正在检索', '正在项目中进行全面搜索', '正在调阅相关文件']).toContain(activityCopy('searching', 0))
    expect(['正在修改', '正在写入变更内容', '正在调整代码实现']).toContain(activityCopy('editing', 1))
    expect(['正在检验', '正在运行测试集进行确认', '正在验证变更有效性']).toContain(activityCopy('testing', 2))
    expect(['正在执行', '正在启动项目服务', '正在监控指令执行状态']).toContain(activityCopy('commanding', 3))
  })

  it('falls back to the working group for missing activity categories', () => {
    expect(['正在处理任务', '步骤正在进行中', '系统运行中']).toContain(activityCopy('weird', 0))
  })
})

describe('toolActivityGroup', () => {
  it('classifies search/read/fetch tools as searching', () => {
    expect(toolActivityGroup('grep')).toBe('searching')
    expect(toolActivityGroup('read')).toBe('searching')
    expect(toolActivityGroup('web_fetch')).toBe('searching')
  })

  it('classifies write/edit tools as editing', () => {
    expect(toolActivityGroup('write')).toBe('editing')
    expect(toolActivityGroup('str_replace_editor')).toBe('editing')
  })

  it('classifies test/lint/build tools as testing', () => {
    expect(toolActivityGroup('run_test')).toBe('testing')
    expect(toolActivityGroup('lint')).toBe('testing')
  })

  it('classifies shell/terminal tools as commanding', () => {
    expect(toolActivityGroup('pwsh')).toBe('commanding')
    expect(toolActivityGroup('bash')).toBe('commanding')
  })

  it('returns working for unmatched tools', () => {
    expect(toolActivityGroup('think')).toBe('working')
    expect(toolActivityGroup(undefined)).toBe('working')
  })
})

describe('taskCopy', () => {
  it('strips trailing punctuation and keeps 正在/继续-prefixed tasks as-is', () => {
    expect(taskCopy('正在写测试。')).toBe('正在写测试')
    expect(taskCopy('继续修改文档')).toBe('继续修改文档')
  })

  it('prefixes action-verb tasks with 正在 (dsh-dafeiyu 句式：正在 + 原文)', () => {
    expect(taskCopy('修改 bug')).toBe('正在修改 bug')
    expect(taskCopy('搜索相关代码')).toBe('正在搜索相关代码')
    expect(taskCopy('整理文档')).toBe('正在整理文档')
  })

  it('wraps other tasks in 正在处理「…」', () => {
    expect(taskCopy('把动画接到气泡')).toBe('正在处理「把动画接到气泡」')
  })

  it('never appends the dsh-dafeiyu sentence-final particle 呢', () => {
    for (const task of ['正在写测试', '继续修改文档', '修改 bug', '把动画接到气泡'])
      expect(taskCopy(task)).not.toContain('呢')
  })

  it('returns undefined for empty/whitespace tasks', () => {
    expect(taskCopy(undefined)).toBeUndefined()
    expect(taskCopy('   ')).toBeUndefined()
    expect(taskCopy('')).toBeUndefined()
  })
})

describe('sessionTitle', () => {
  it('prefers title/displayTitle/name as the base', () => {
    expect(sessionTitle({ title: '修复宠物' })).toBe('修复宠物')
    expect(sessionTitle({ displayTitle: '修复宠物' })).toBe('修复宠物')
    expect(sessionTitle({ name: '修复宠物' })).toBe('修复宠物')
  })

  it('falls back to the untitled label instead of leaking the internal session id', () => {
    const title = sessionTitle({ id: 'session-2a2abd15-b0d4-499c-aed1-dd1424003bb3' })
    expect(title).toBe(UNTITLED_SESSION_TITLE)
    expect(title).not.toContain('session-')
    // 空白标题与缺失标题同档：都不得回落到 id。
    expect(sessionTitle({ title: '   ', displayTitle: '' })).toBe(UNTITLED_SESSION_TITLE)
  })

  it('keeps the attention prefixes on top of the untitled fallback', () => {
    for (const phase of ['approval', 'user-question', 'blocked']) {
      const title = sessionTitle({ phase, title: '会话' })
      expect(title).toContain('会话')
      expect(title).toBe(sessionTitle({ phase, title: '会话' }))
    }
    expect(sessionTitle({ phase: 'approval' })).toContain(UNTITLED_SESSION_TITLE)
    expect(sessionTitle({ origin: 'subagent' })).toContain(UNTITLED_SESSION_TITLE)
  })
})
