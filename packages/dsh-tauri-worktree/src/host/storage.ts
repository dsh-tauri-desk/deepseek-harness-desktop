/**
 * host/storage.ts — 工作树宿主状态的持久化：binding ledger + 一次性检出上下文。
 *
 * 适配 unstorage(fs)：读写走 dsh-tauri 共享的 createAtomicFsStorage（tmp+rename
 * 原子写，unstorage fs driver 的 setItem 是直接 writeFile，不能保证读者看不到
 * 半份 JSON）。同步读面（loadLedgerSync / loadCheckoutContextsSync）保留给
 * 工具 execute 与 systemPrompt 渲染路径（小文件同步读可接受）。
 */

import type { CheckoutContext, CheckoutContexts, Ledger } from './types.js'
import { readFileSync } from 'node:fs'
import { createAtomicFsStorage } from 'dsh-tauri'
import { join } from 'pathe'

const LEDGER_KEY = 'ledger.json'
const CHECKOUT_CONTEXT_KEY = 'checkout-context.json'

function store(worktreesRoot: string) {
  return createAtomicFsStorage(worktreesRoot)
}

function parseRecord<T>(value: string): Record<string, T> {
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' ? parsed as Record<string, T> : {}
}

export async function loadLedger(worktreesRoot: string): Promise<Ledger> {
  try {
    const value = await store(worktreesRoot).getItem<Ledger>(LEDGER_KEY)
    return value && typeof value === 'object' ? value : {}
  }
  catch {
    return {}
  }
}

export function loadLedgerSync(worktreesRoot: string): Ledger {
  try {
    return parseRecord<Ledger[string]>(readFileSync(join(worktreesRoot, LEDGER_KEY), 'utf8')) as Ledger
  }
  catch {
    return {}
  }
}

export async function saveLedger(worktreesRoot: string, ledger: Ledger): Promise<void> {
  await store(worktreesRoot).setItem(LEDGER_KEY, `${JSON.stringify(ledger, null, 2)}\n`)
}

export function loadCheckoutContextsSync(worktreesRoot: string): CheckoutContexts {
  try {
    const raw = readFileSync(join(worktreesRoot, CHECKOUT_CONTEXT_KEY), 'utf8')
    return parseRecord<CheckoutContext>(raw) as CheckoutContexts
  }
  catch {
    return {}
  }
}

export async function setPendingCheckoutContext(worktreesRoot: string, sessionId: string, context: CheckoutContext): Promise<void> {
  const contexts = loadCheckoutContextsSync(worktreesRoot)
  contexts[sessionId] = context
  await store(worktreesRoot).setItem(CHECKOUT_CONTEXT_KEY, `${JSON.stringify(contexts, null, 2)}\n`)
}

export async function clearPendingCheckoutContext(worktreesRoot: string, sessionId: string): Promise<void> {
  const contexts = loadCheckoutContextsSync(worktreesRoot)
  if (!contexts[sessionId])
    return
  delete contexts[sessionId]
  await store(worktreesRoot).setItem(CHECKOUT_CONTEXT_KEY, `${JSON.stringify(contexts, null, 2)}\n`)
}
