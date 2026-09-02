/**
 * host/storage.ts — 工作树宿主状态的持久化：binding ledger + 一次性检出上下文。
 *
 * 为什么按会话分文件：旧实现把全部 binding 挤进单个 `ledger.json`（load-modify-save
 * 整表读写）。同一组会话下多个工作树的 create/checkout/discard 会并发 load-modify-save
 * 同一文件，互相覆盖并反复踩 rename 的 EPERM 锁竞争（「多点几次多出一堆工作树」）。
 * 这里改为每个会话独立文件 `ledger/<sessionId>.json`，读改写只作用于单个会话，天然消除
 * 共享文件竞争，无需额外加锁。
 *
 * key 形态：unstorage 以 `:` 作层级分隔符，driver 把它还原成 `/`（见 dsh-tauri 的
 * createAtomicFsStorage）。故「ledger:sess-id.json」落在 `base/ledger/sess-id.json`。
 * 原子写走 dsh-tauri 共享的 createAtomicFsStorage（tmp+rename）。
 *
 * 迁移：旧版本遗留的 `ledger.json` / `checkout-context.json` 整表文件在首次运行时拆分成
 * 按会话文件并删除，幂等。同步读面对迁移前的窗口做「旧文件单键回退」。同步面保留给
 * 工具 execute 与 systemPrompt 渲染路径（小文件同步读可接受）。
 */

import type { Binding, CheckoutContext } from '../types/index.js'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createAtomicFsStorage } from 'dsh-tauri'
import { join } from 'pathe'

const LEDGER_DIR = 'ledger'
const CHECKOUT_CONTEXT_DIR = 'checkout-context'
/** 旧版本整表文件（迁移后删除）。 */
const LEGACY_LEDGER_KEY = 'ledger.json'
const LEGACY_CHECKOUT_CONTEXT_KEY = 'checkout-context.json'

function store(worktreesRoot: string) {
  return createAtomicFsStorage(worktreesRoot)
}

/** 会话 id → 按会话文件的相对路径（不含 base）。 */
function sessionFile(sessionId: string): string {
  return `${LEDGER_DIR}/${sessionId}.json`
}

function checkoutContextFile(sessionId: string): string {
  return `${CHECKOUT_CONTEXT_DIR}/${sessionId}.json`
}

/** 解析单个对象；文件缺失或内容损坏返回 null。 */
function parseBinding(raw: string): Binding | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? parsed as Binding
      : null
  }
  catch {
    return null
  }
}

function parseCheckoutContext(raw: string): CheckoutContext | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? parsed as CheckoutContext
      : null
  }
  catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// binding ledger（按会话独立文件）
// ---------------------------------------------------------------------------

/**
 * 同步读取某会话的 binding。优先按会话文件；对迁移前窗口回退旧整表 `ledger.json`。
 * 文件缺失/损坏一律返回 null（绝不让只读渲染路径抛错）。
 */
export function loadBindingSync(worktreesRoot: string, sessionId: string): Binding | null {
  try {
    const raw = readFileSync(join(worktreesRoot, sessionFile(sessionId)), 'utf8')
    const binding = parseBinding(raw)
    if (binding)
      return binding
  }
  catch {
    /* 会话文件缺失则回退旧整表 */
  }
  return legacyLedgerEntrySync(worktreesRoot, sessionId)
}

/** 从旧整表 `ledger.json` 取单键（迁移前的只读回退；不在此处落盘）。 */
function legacyLedgerEntrySync(worktreesRoot: string, sessionId: string): Binding | null {
  try {
    const raw = readFileSync(join(worktreesRoot, LEGACY_LEDGER_KEY), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const entry = (parsed as Record<string, unknown>)[sessionId]
      return entry && typeof entry === 'object' ? entry as Binding : null
    }
  }
  catch {
    /* 旧文件缺失/损坏按无绑定处理 */
  }
  return null
}

/** 异步读绑定：先保证旧整表已迁移，再读按会话文件。 */
export async function loadBinding(worktreesRoot: string, sessionId: string): Promise<Binding | null> {
  await migrateLegacyLedger(worktreesRoot)
  return loadBindingSync(worktreesRoot, sessionId)
}

/** 原子写某个会话的 binding（幂等：同会话重复写只覆盖自己的文件）。 */
export async function saveBinding(worktreesRoot: string, sessionId: string, binding: Binding): Promise<void> {
  await store(worktreesRoot).setItem(
    sessionFile(sessionId),
    `${JSON.stringify(binding, null, 2)}\n`,
  )
}

/** 删除某个会话的 binding（不存在时视为成功）。 */
export async function removeBinding(worktreesRoot: string, sessionId: string): Promise<void> {
  await store(worktreesRoot).removeItem(sessionFile(sessionId))
}

/** 同步枚举全部 binding（仅自愈/按 key 寻址等「需要全量」的路径使用）。 */
export function listBindingsSync(worktreesRoot: string): Binding[] {
  const results: Binding[] = []
  const dir = join(worktreesRoot, LEDGER_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  }
  catch {
    return results // ledger/ 目录尚不存在
  }
  for (const name of names) {
    // 只认本方案的 `<sessionId>.json` 叶文件，忽略迁移残留的 tmp/目录项。
    if (!name.endsWith('.json'))
      continue
    try {
      const binding = parseBinding(readFileSync(join(dir, name), 'utf8'))
      if (binding)
        results.push(binding)
    }
    catch {
      /* 单个文件损坏不阻断其余 */
    }
  }
  return results
}

/** 异步枚举全部 binding；先迁移旧整表再枚举，保证结果完整。 */
export async function listBindings(worktreesRoot: string): Promise<Binding[]> {
  await migrateLegacyLedger(worktreesRoot)
  return listBindingsSync(worktreesRoot)
}

// ---------------------------------------------------------------------------
// 旧整表迁移
// ---------------------------------------------------------------------------

/** 旧版本整表 migration：拆分到按会话文件后删除旧文件。幂等（旧文件不存在即跳过）。 */
export async function migrateLegacyLedger(worktreesRoot: string): Promise<void> {
  const legacyPath = join(worktreesRoot, LEGACY_LEDGER_KEY)
  if (!existsSync(legacyPath))
    return
  const s = store(worktreesRoot)
  try {
    const raw = readFileSync(legacyPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const [sessionId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object')
          continue
        await s.setItem(sessionFile(sessionId), `${JSON.stringify(entry, null, 2)}\n`)
      }
    }
    // 所有按会话文件落盘成功后，才删旧整表（提交点）。
    rmSync(legacyPath, { force: true })
  }
  catch {
    // 迁移失败不动旧文件，保留可重试状态；分文件写入均幂等，重跑安全。
  }
}

// ---------------------------------------------------------------------------
// 一次检出上下文（按会话独立文件）
// ---------------------------------------------------------------------------

/** 同步读取某会话的一次性检出上下文（迁移前回退旧整表）。 */
export function loadCheckoutContextSync(worktreesRoot: string, sessionId: string): CheckoutContext | null {
  try {
    const raw = readFileSync(join(worktreesRoot, checkoutContextFile(sessionId)), 'utf8')
    const context = parseCheckoutContext(raw)
    if (context)
      return context
  }
  catch {
    /* 会话文件缺失则回退旧整表 */
  }
  try {
    const raw = readFileSync(join(worktreesRoot, LEGACY_CHECKOUT_CONTEXT_KEY), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const entry = (parsed as Record<string, unknown>)[sessionId]
      if (entry && typeof entry === 'object')
        return entry as CheckoutContext
    }
  }
  catch {
    /* 旧文件缺失/损坏按无上下文处理 */
  }
  return null
}

/** 写入某会话的一次性检出上下文（原子写，只碰自己的文件）。 */
export async function setPendingCheckoutContext(worktreesRoot: string, sessionId: string, context: CheckoutContext): Promise<void> {
  await store(worktreesRoot).setItem(
    checkoutContextFile(sessionId),
    `${JSON.stringify(context, null, 2)}\n`,
  )
}

/** 清除某会话的一次性检出上下文（不存在时视为成功）。 */
export async function clearPendingCheckoutContext(worktreesRoot: string, sessionId: string): Promise<void> {
  await store(worktreesRoot).removeItem(checkoutContextFile(sessionId))
}
