import type { CheckoutContext, CheckoutContexts, Ledger } from './types.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const LEDGER_NAME = 'ledger.json'
const CHECKOUT_CONTEXT_NAME = 'checkout-context.json'

function ledgerPath(worktreesRoot: string): string {
  return join(worktreesRoot, LEDGER_NAME)
}

function checkoutContextPath(worktreesRoot: string): string {
  return join(worktreesRoot, CHECKOUT_CONTEXT_NAME)
}

function parseRecord<T>(value: string): Record<string, T> {
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' ? parsed as Record<string, T> : {}
}

export async function loadLedger(worktreesRoot: string): Promise<Ledger> {
  try {
    return parseRecord(await readFile(ledgerPath(worktreesRoot), 'utf8'))
  }
  catch {
    return {}
  }
}

export function loadLedgerSync(worktreesRoot: string): Ledger {
  try {
    return parseRecord(readFileSync(ledgerPath(worktreesRoot), 'utf8'))
  }
  catch {
    return {}
  }
}

export async function saveLedger(worktreesRoot: string, ledger: Ledger): Promise<void> {
  await mkdir(worktreesRoot, { recursive: true })
  await writeFile(ledgerPath(worktreesRoot), `${JSON.stringify(ledger, null, 2)}\n`)
}

export function loadCheckoutContextsSync(worktreesRoot: string): CheckoutContexts {
  try {
    return parseRecord(readFileSync(checkoutContextPath(worktreesRoot), 'utf8'))
  }
  catch {
    return {}
  }
}

async function saveCheckoutContexts(worktreesRoot: string, contexts: CheckoutContexts): Promise<void> {
  await mkdir(worktreesRoot, { recursive: true })
  const path = checkoutContextPath(worktreesRoot)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(contexts, null, 2)}\n`)
  await rename(temporary, path)
}

export async function setPendingCheckoutContext(worktreesRoot: string, sessionId: string, context: CheckoutContext): Promise<void> {
  const contexts = loadCheckoutContextsSync(worktreesRoot)
  contexts[sessionId] = context
  await saveCheckoutContexts(worktreesRoot, contexts)
}

export async function clearPendingCheckoutContext(worktreesRoot: string, sessionId: string): Promise<void> {
  const contexts = loadCheckoutContextsSync(worktreesRoot)
  if (!contexts[sessionId])
    return
  delete contexts[sessionId]
  await saveCheckoutContexts(worktreesRoot, contexts)
}
