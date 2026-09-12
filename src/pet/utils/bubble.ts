/**
 * bubble-copy.ts — 桌宠会话气泡文案的纯逻辑层（对齐 dsh-dafeiyu src/status-copy.js）。
 *
 * 分组文案（thinking/working/result/waiting/approval/success/error/…）+ seed 稳定选句、
 * 工具活动分类文案（activityCopy）、todo 任务文案（taskCopy）都是纯函数，无 React/DOM
 * 依赖，可独立单测。use-bubble.ts 只负责把会话状态喂进来取一句展示。
 * 桌宠窗口无 i18n 基础设施：按窗口语言（IS_ZH）就地取中/英文案。
 */

/** 桌宠窗口无 i18n 基础设施，就地按窗口语言取单语文案（与 pet.tsx 保留文案一致）。 */
export const IS_ZH = (typeof document !== 'undefined' ? document.documentElement.lang || navigator.language : 'zh-CN')
  .toLowerCase()
  .startsWith('zh')

/**
 * 气泡文案库（对齐 dsh-dafeiyu src/status-copy.js 分组 + seed 稳定选句）。
 * 各组多备选句：statusCopy 按会话稳定 seed 选一句，避免同一会话反复切换文案。
 */
const STATUS_COPY: Record<string, readonly string[]> = {
  thinking: IS_ZH
    ? ['正在分析', '思考中', '整理结果中']
    : ['Analyzing information', 'Thinking', 'Organizing results'],
  working: IS_ZH
    ? ['正在处理任务', '步骤正在进行中', '系统运行中']
    : ['Processing task', 'Step in progress', 'System is working'],
  result: IS_ZH
    ? ['正在整理结果', '步骤已完成，准备下一步', '正在确认后续操作']
    : ['Organizing results', 'Step completed, preparing for next step', 'Confirming next action'],
  waiting: IS_ZH
    ? ['等待确认', '需提供后续指令', '请决策下一步操作']
    : ['Awaiting your confirmation', 'Requires your input', 'Please decide on the next step'],
  approval: IS_ZH
    ? ['等待审批', '需授权确认', '敏感操作确认授权']
    : ['Awaiting your approval', 'Authorization required', 'Please confirm and authorize this action'],
  success: IS_ZH
    ? ['任务已完成', '本阶段任务已完成', '流程执行成功']
    : ['Task completed successfully', 'Current phase completed', 'Execution succeeded'],
  running: IS_ZH
    ? ['任务运行中', '当前步骤正在处理']
    : ['Task is running', 'Current step is processing'],
  review: IS_ZH
    ? ['正在汇总变更', '变更已就绪，等待审阅']
    : ['Consolidating', 'Ready for your review'],
  failed: IS_ZH
    ? ['步骤执行失败', '操作执行过程中发生异常']
    : ['Step execution failed', 'An error occurred during operation'],
  error: IS_ZH
    ? ['任务发生错误', '出现异常，请进行排查', '流程未能成功']
    : ['Task encountered an error', 'Exception detected, please check', 'Process failed to complete'],
  stopped: IS_ZH
    ? ['任务已终止', '任务已在此处暂停']
    : ['Task terminated', 'Task paused at this stage'],
} as const

/** 工具活动分类 → 文案（对齐 dsh-dafeiyu activityCopy：按工具分类选句）。 */
const ACTIVITY_COPY: Record<string, readonly string[]> = {
  searching: IS_ZH
    ? ['正在检索', '正在项目中进行全面搜索', '正在调阅相关文件']
    : ['Searching', 'Searching across the project', 'Checking related files'],
  editing: IS_ZH
    ? ['正在修改', '正在写入变更内容', '正在调整代码实现']
    : ['Editing', 'Applying changes', 'Adjusting implementation'],
  testing: IS_ZH
    ? ['正在检验', '正在运行测试集进行确认', '正在验证变更有效性']
    : ['Verifying', 'Running test suites', 'Verifying changes'],
  commanding: IS_ZH
    ? ['正在执行', '正在启动项目服务', '正在监控指令执行状态']
    : ['Executing', 'Starting project services', 'Monitoring command execution'],
} as const

/** seed → 稳定非负整数（数值取整数部分，否则按字符码点求和；对齐 dsh-dafeiyu seedNumber）。 */
export function seedNumber(seed: string | number | undefined): number {
  const value = String(seed ?? '')
  const numeric = Number(value)
  if (Number.isFinite(numeric))
    return Math.abs(Math.trunc(numeric))
  return [...value].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0)
}

/** 按组取一句稳定文案（选句随 seed 变化但同一 seed 恒定）。 */
export function statusCopy(group: string, seed?: string | number): string {
  const variants = STATUS_COPY[group] ?? STATUS_COPY.working
  return variants[seedNumber(seed) % variants.length] ?? variants[0]
}

/** 工具活动分类文案（dsh-dafeiyu activityCopy 的对齐实现）；无分类回落 working 通用文案。 */
export function activityCopy(activity: string, seed?: string | number): string {
  const variants = ACTIVITY_COPY[activity] ?? STATUS_COPY.working
  return variants[seedNumber(seed) % variants.length] ?? variants[0]
}

/**
 * 任务文本 → 气泡文案（对齐 dsh-dafeiyu taskCopy 的句式，但**不带句末语气词**：
 * 「正在/继续」开头 → 原文；动作动词开头 → 正在+原文；否则 正在处理「原文」）。
 * 上游 dsh-dafeiyu 每句都以「呢」收尾，本仓库按用户反馈去掉该语气词。
 */
export function taskCopy(task: string | undefined): string | undefined {
  const value = String(task ?? '').trim().replace(/[。！？.!?]+$/u, '')
  if (!value)
    return undefined
  if (/^(?:正在|继续)/u.test(value))
    return value
  if (/^(?:准备|检查|验证|修改|修复|测试|构建|整理|分析|梳理|查找|搜索|读取|实现)/u.test(value))
    return `正在${value}`
  return `正在处理「${value}」`
}

/** 工具名 → 活动分类（对齐 dsh-dafeiyu toolActivity 正则 + DSH 实际工具名 pwsh；供 working 档无 liveActivity 时选文案）。 */
export function toolActivityGroup(tool: string | undefined): string {
  const value = String(tool || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value))
    return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value))
    return 'editing'
  if (/test|check|lint|build|verify/.test(value))
    return 'testing'
  if (/shell|bash|exec|command|terminal|powershell|pwsh/.test(value))
    return 'commanding'
  return 'working'
}

/** 会话标题兜底文案：标题还没生成（或首条提示尚未出标题）时不要暴露内部 session id。 */
export const UNTITLED_SESSION_TITLE = IS_ZH ? '新会话' : 'New session'

/** 会话标题前缀（等待/子代理等需要用户注意的态）。 */
const SESSION_LABELS = {
  subagent: IS_ZH ? '子代理' : 'Subagent',
  waitApproval: IS_ZH ? '需授权' : 'Needs approval',
  waitChoice: IS_ZH ? '需选择' : 'Needs your input',
} as const

/**
 * 标题展示只读这些字段：标题与身份来自宿主投影，phase/origin 决定前缀。
 * 带索引签名是为了直接吃完整展示态（`use-bubble` 的会话对象），多余字段一律忽略。
 */
export interface SessionTitleSource {
  [key: string]: unknown
  title?: unknown
  displayTitle?: unknown
  name?: unknown
  phase?: unknown
  origin?: unknown
}

/**
 * 会话标题（含等待/子代理前缀）。
 *
 * 标题缺失时回落到 {@link UNTITLED_SESSION_TITLE}（「新会话」），**绝不回落到 `session.id`**：
 * 会话 id 是内部标识，标题还没生成时它会以 `session-xxxx-xxxx…` 形态漏进气泡标题。
 */
export function sessionTitle(session: SessionTitleSource): string {
  const base = [session.title, session.displayTitle, session.name]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
    ?? UNTITLED_SESSION_TITLE

  if (session.phase === 'approval')
    return `${SESSION_LABELS.waitApproval} · ${base}`
  if (session.phase === 'user-question' || session.phase === 'blocked')
    return `${SESSION_LABELS.waitChoice} · ${base}`
  if (session.origin === 'subagent')
    return `${SESSION_LABELS.subagent} · ${base}`
  return base
}
