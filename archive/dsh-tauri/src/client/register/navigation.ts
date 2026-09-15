/**
 * register/navigation.ts — 壳层导航栏「文件」菜单的两条命令（宿主 → iframe）：
 *
 * - `dsh://session:new`（新聊天）：走官方「新建会话」同款入口
 *   `uiWorkspace.startSession()`；
 * - `dsh://workspace:add`（打开文件夹）：走官方「添加工作区」流程
 *   （`uiWorkspace.pickDirectory()` → `workspaces.create({ path })` → `startSession(id)`），
 *   与 ui-workspace `WorkspacePickFlow.adoptDirectory` 逐步一致。
 *
 * 两者都只**调用**官方能力，不复制官方 UI。官方服务缺席（旧核心 / 服务未注册）时按
 * 退级阶梯落到 DOM：点击官方侧栏的「新建会话」/「添加工作区」按钮（稳定 aria-label）。
 * 两条路径都失败才告警——绝不静默半工作。
 */
import type { ClientContext } from '../types'
import {
  ADD_WORKSPACE_SELECTOR,
  CMD_ADD_WORKSPACE,
  CMD_NEW_SESSION,
  NEW_SESSION_SELECTOR,
} from '../constants'
import { createLifecycleController } from '../controller'
import { listenParent } from '../service/listen-parent'
import { resolveAddWorkspace, resolveStartSession } from '../utils/compat'
import { reportPluginError } from '../utils/error'

/** 点击官方按钮（DOM 退级路径）；按钮不存在时返回 false。 */
function clickOfficialButton(selector: string): boolean {
  const button = document.querySelector<HTMLButtonElement>(selector)
  if (button === null)
    return false
  button.click()
  return true
}

/** 新聊天：官方 startSession；服务缺席时退级为点官方「新建会话」按钮。 */
async function startNewChat(ctx: ClientContext): Promise<void> {
  const start = resolveStartSession(ctx)
  if (start === undefined) {
    if (!clickOfficialButton(NEW_SESSION_SELECTOR))
      console.warn('[dsh-tauri] new chat unavailable: no workspace navigation service')
    return
  }
  const result = start()
  // startSession 在 Alpha 返回 void、rc.2 返回 Promise：只 await 真正的 thenable，
  // 避免对同步返回值做无意义等待。
  if (result instanceof Promise)
    await result
}

/** 打开文件夹：官方「添加工作区」；能力缺席时退级为点官方「添加工作区」按钮。 */
async function addWorkspace(ctx: ClientContext): Promise<void> {
  const runtime = resolveAddWorkspace(ctx)
  if (runtime === undefined) {
    if (!clickOfficialButton(ADD_WORKSPACE_SELECTOR))
      console.warn('[dsh-tauri] add workspace unavailable: no workspace service or official button')
    return
  }
  const path = await runtime.pickDirectory()
  // 用户在原生目录选择器里取消：是正常结果，不是失败。
  if (path === null || path === undefined)
    return
  const workspace = await runtime.createWorkspace({ path })
  runtime.startSession(workspace.workspaceId)
}

/**
 * 注册导航命令监听（宿主 → iframe）。
 * @param ctx - 客户端根上下文（用于按需探测官方工作区服务）。
 * @returns 卸载函数（注销命令监听）。
 */
export function registerNavigation(ctx: ClientContext): () => void {
  const controller = createLifecycleController()

  controller.add(listenParent<{ type?: string }>((data) => {
    // 异步 RPC 失败（目录选择器不可用 / 建工作区被拒）上报宿主插件面板，
    // 不影响后续命令。
    if (data.type === CMD_NEW_SESSION) {
      void startNewChat(ctx).catch((error: unknown) => {
        reportPluginError(error, 'runtime')
      })
      return
    }
    if (data.type === CMD_ADD_WORKSPACE) {
      void addWorkspace(ctx).catch((error: unknown) => {
        reportPluginError(error, 'runtime')
      })
    }
  }, [CMD_NEW_SESSION, CMD_ADD_WORKSPACE]))

  return () => controller.dispose()
}
