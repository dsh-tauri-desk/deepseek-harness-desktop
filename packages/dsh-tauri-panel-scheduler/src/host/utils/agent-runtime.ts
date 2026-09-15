import type { PlatformModuleLoader, SchedulerRuntimeModules, SetupAgentLike } from './agent-runtime.types'
import { isFunction } from 'lodash-es'

type RuntimeModuleExports = Partial<SchedulerRuntimeModules>

export async function loadSchedulerRuntimeModules(loader: PlatformModuleLoader): Promise<SchedulerRuntimeModules> {
  const [agent, llm, approval] = await Promise.all([
    loader.import('@deepseek-ai/dsh-agent'),
    loader.import('@deepseek-ai/dsh-llm'),
    loader.import('@deepseek-ai/dsh-user-approval'),
  ])
  return {
    installModelSelection: resolveRuntimeExport(loader, agent, 'installModelSelection'),
    createUserMessage: resolveRuntimeExport(loader, llm, 'createUserMessage'),
    setApprovalPolicy: resolveRuntimeExport(loader, approval, 'setApprovalPolicy'),
  }
}

export function resolveSetupAgent(
  agentCtx: unknown,
  createdAgent?: SetupAgentLike,
): SetupAgentLike | undefined {
  return createdAgent ?? (agentCtx as { agent?: SetupAgentLike } | undefined)?.agent
}

// --- internal ---

function resolveRuntimeExport<T extends keyof SchedulerRuntimeModules>(
  loader: PlatformModuleLoader,
  moduleExports: unknown,
  name: T,
): SchedulerRuntimeModules[T] {
  const direct = (moduleExports as RuntimeModuleExports | null)?.[name]
  if (isFunction(direct))
    return direct as SchedulerRuntimeModules[T]

  const unwrapped = loader.unwrapExports(moduleExports) as RuntimeModuleExports | null
  const fallback = unwrapped?.[name]
  if (!isFunction(fallback))
    throw new TypeError(`SCHEDULER_RUNTIME_EXPORT_MISSING: ${String(name)}`)
  return fallback as SchedulerRuntimeModules[T]
}
