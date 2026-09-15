import type { ClientAdapter } from 'dsh-tauri/client'
import type { PetActionResult, PetStatus } from './pet.types'
import { PET_HATCH_PROMPT } from '../constants'
import { store } from '../store'
import {
  getPetList,
  getPetStatus,
  getPresetPets,
  postActivePet,
  postPetEnabled,
  postPetImport,
  postPetSize,
} from './pet.invoke'
import { chooseWorkspace, messageOf } from './pet.utils'

/**
 * service/pet.ts — 桌宠领域服务。
 *
 * 两种原型：Query（`load*`，只读数据并更新 store）与 Action（领域动词，响应用户意图
 * 并更新 store）。无模块级可变状态、无副作用生命周期。
 */

/** Query：拉取桌宠状态快照；按轮次提交，过期响应不覆盖新状态。 */
export async function loadPetStatus(): Promise<PetStatus | null> {
  const revision = store.pet.beginFetch()
  try {
    const status = await getPetStatus()
    store.pet.commitFetch(revision, status)
    return status
  }
  catch (error) {
    console.error('[dsh-tauri-pet] load pet status failed:', error)
    return null
  }
}

/** Query：装载预设 / Chat / Codex 三份清单，并顺带刷新共享状态快照。 */
export async function loadPetCatalog(): Promise<PetActionResult> {
  const revision = store.pet.beginFetch()
  try {
    const [status, chat, codex, presets] = await Promise.all([
      getPetStatus(),
      getPetList('chat'),
      getPetList('codex'),
      getPresetPets(),
    ])
    store.pet.setCatalog({ presets, chat, codex })
    store.pet.commitFetch(revision, status)
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] load pet catalog failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：选中宠物（状态以桌面端返回的权威快照为准）。 */
export async function choosePet(input: { id: string }): Promise<PetActionResult> {
  try {
    store.pet.setStatus(await postActivePet(input.id))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] choose pet failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：启用预设宠物——选中它，并确保桌宠被唤醒。 */
export async function enablePet(input: { id: string }): Promise<PetActionResult> {
  try {
    let status = await postActivePet(input.id)
    if (!status.enabled)
      status = await postPetEnabled(true)
    store.pet.setStatus(status)
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] enable pet failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Action：取消选择；仍在启用时一并关闭桌宠（无内容可渲染，不留空窗口）。
 *
 * 先关闭再清空：若第二步失败，最坏情况也只是保留选择但窗口已销毁。任一步失败都从
 * 后端重拉状态，避免界面与持久层不一致。
 */
export async function clearPetSelection(): Promise<PetActionResult> {
  const status = store.pet.$state.status
  try {
    if (status?.enabled)
      store.pet.setStatus(await postPetEnabled(false))
    store.pet.setStatus(await postActivePet(''))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] clear pet selection failed:', error)
    await loadPetStatus()
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：启用/关闭桌宠（纯持久开关，关闭后重启不再自动拉起）。 */
export async function togglePet(input: { enabled: boolean }): Promise<PetActionResult> {
  try {
    store.pet.setStatus(await postPetEnabled(input.enabled))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] toggle pet failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：调整桌宠窗口大小。 */
export async function resizePet(input: { size: number }): Promise<PetActionResult> {
  try {
    store.pet.setStatus(await postPetSize(input.size))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] resize pet failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/** Action：导入宠物压缩包（base64），成功后刷新 Codex 清单。 */
export async function importPetArchive(input: { name: string, data: string }): Promise<PetActionResult> {
  try {
    await postPetImport(input.name, input.data)
    store.pet.setCodexPets(await getPetList('codex'))
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] import pet failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * Action：新建桌宠会话——挑工作区、建会话、装一次性草稿、打开会话并收起设置面板。
 *
 * 工作区目标顺序见 `chooseWorkspace`；官方导航能力缺席时明确失败，不猜核心版本。
 */
export async function createPetSession(input: {
  adapter: ClientAdapter
  close?: () => void
}): Promise<PetActionResult> {
  const { adapter, close } = input
  const workspaceId = chooseWorkspace(adapter)
  const connectWorkspace = adapter.workspaces.connectWorkspace
  const open = adapter.sessions.open
  if (workspaceId === undefined || connectWorkspace === undefined)
    return { ok: false, error: 'PET_WORKSPACE_UNAVAILABLE: no workspace can create a pet session' }
  if (open === undefined)
    return { ok: false, error: 'PET_SESSION_UNAVAILABLE: session opener is unavailable' }

  try {
    const sessionId = await connectWorkspace(workspaceId)
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      return { ok: false, error: 'PET_SESSION_UNAVAILABLE: workspace did not return a session id' }
    store.pet.setPrefill(sessionId, PET_HATCH_PROMPT)
    close?.()
    open(sessionId)
    return { ok: true }
  }
  catch (error) {
    console.error('[dsh-tauri-pet] create pet session failed:', error)
    return { ok: false, error: messageOf(error) }
  }
}
