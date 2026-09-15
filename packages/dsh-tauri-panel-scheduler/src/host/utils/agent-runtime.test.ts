import { describe, expect, it, vi } from 'vitest'
import { loadSchedulerRuntimeModules, resolveSetupAgent } from './agent-runtime'

describe('loadSchedulerRuntimeModules', () => {
  it('resolves DSH-owned modules through the platform loader', async () => {
    const installModelSelection = vi.fn()
    const createUserMessage = vi.fn()
    const setApprovalPolicy = vi.fn()
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', { installModelSelection }],
      ['@deepseek-ai/dsh-llm', { createUserMessage }],
      ['@deepseek-ai/dsh-user-approval', { setApprovalPolicy }],
    ])
    const loader = {
      import: vi.fn(async (name: string) => modules.get(name)),
      unwrapExports: vi.fn((value: unknown) => value),
    }

    const runtime = await loadSchedulerRuntimeModules(loader)

    expect(loader.import).toHaveBeenCalledTimes(3)
    expect(loader.import).toHaveBeenNthCalledWith(1, '@deepseek-ai/dsh-agent')
    expect(loader.import).toHaveBeenNthCalledWith(2, '@deepseek-ai/dsh-llm')
    expect(loader.import).toHaveBeenNthCalledWith(3, '@deepseek-ai/dsh-user-approval')
    expect(runtime).toEqual({ installModelSelection, createUserMessage, setApprovalPolicy })
  })

  it('prefers named exports when unwrapExports selects a default export', async () => {
    const installModelSelection = vi.fn()
    const createUserMessage = vi.fn()
    const setApprovalPolicy = vi.fn()
    const loader = {
      import: vi.fn(async (name: string) => ({
        ...(name === '@deepseek-ai/dsh-agent' ? { installModelSelection } : {}),
        ...(name === '@deepseek-ai/dsh-llm' ? { createUserMessage } : {}),
        ...(name === '@deepseek-ai/dsh-user-approval' ? { setApprovalPolicy } : {}),
        default: { wrongExport: true },
      })),
      unwrapExports: vi.fn(() => ({ wrongExport: true })),
    }

    const runtime = await loadSchedulerRuntimeModules(loader)

    expect(runtime).toEqual({ installModelSelection, createUserMessage, setApprovalPolicy })
    expect(loader.unwrapExports).not.toHaveBeenCalled()
  })
})

describe('resolveSetupAgent', () => {
  it('prefers the Agent the 0.1.5+ host passes as the setup second parameter', () => {
    const session = { id: 'task-1' }
    const agentCtx = {
      get agent(): never {
        throw new Error('cannot get property "agent" without inject')
      },
    }

    expect(resolveSetupAgent(agentCtx, { session })).toEqual({ session })
  })

  it('falls back to the context entry on hosts that predate the explicit Agent parameter', () => {
    const session = { id: 'task-1' }

    expect(resolveSetupAgent({ agent: { session } })).toEqual({ session })
  })

  it('returns undefined when neither the parameter nor the context entry carries an Agent', () => {
    expect(resolveSetupAgent(undefined)).toBeUndefined()
    expect(resolveSetupAgent({})).toBeUndefined()
  })
})
