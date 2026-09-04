import type { PetActivity, PetAsset, PetListItem, PetSessionStatus, PetSource, PetStatus } from '../types'
import { invokeBridgedTauri } from 'dsh-tauri/client'
import {
  CMD_GET_BUILTIN_PET_ASSETS,
  CMD_GET_PET_ASSET,
  CMD_GET_PET_STATUS,
  CMD_HIDE_PET,
  CMD_IMPORT_PET,
  CMD_LIST_PETS,
  CMD_SET_ACTIVE_PET,
  CMD_SET_PET_ACTIVITY,
  CMD_SET_PET_ENABLED,
  CMD_SET_PET_SESSIONS,
  CMD_SET_PET_SIZE,
  CMD_SHOW_PET,
} from '../constants'

/** Query the complete persistent and transient pet state. */
export function fetchPetStatus(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_GET_PET_STATUS)
}

/** Persistently enable or disable the pet capability. */
export function setPetEnabled(enabled: boolean): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_ENABLED, { enabled })
}

/** Persist the selected pet package id. */
export function setActivePet(id: string): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_ACTIVE_PET, { id })
}

/** Persist the pet scale percentage. */
export function setPetSize(size: number): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_SIZE, { size })
}

/** Restore a previously enabled pet window. */
export function showPet(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SHOW_PET)
}

/** Hide the window without disabling the persisted pet capability. */
export function hidePet(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_HIDE_PET)
}

/** List imported Codex pet archives. */
export function fetchPetList(source: PetSource): Promise<PetListItem[]> {
  return invokeBridgedTauri<PetListItem[]>(CMD_LIST_PETS, { source })
}

/** Resolve the selected Chat/Codex spritesheet directly from its owner directory. */
export function fetchPetAsset(id: string): Promise<PetAsset> {
  return invokeBridgedTauri<PetAsset>(CMD_GET_PET_ASSET, { id })
}

/** Import one Codex-compatible zip archive. */
export function importPet(name: string, data: string): Promise<PetListItem> {
  return invokeBridgedTauri<PetListItem>(CMD_IMPORT_PET, { name, data })
}

/** Push the current session-derived animation and optional speech bubble. */
export function setPetActivity(activity: PetActivity, bubble?: string): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_ACTIVITY, { activity, bubble })
}

/** Push the complete session snapshot; the pet window derives one visual state and per-session Toasts. */
export function setPetSessions(sessions: PetSessionStatus[]): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_SESSIONS, { sessions })
}

/** Load built-in media through the Rust runtime resource boundary. */
export function fetchBuiltinPetAssets(): Promise<{ assets: Record<string, string> }> {
  return invokeBridgedTauri<{ assets: Record<string, string> }>(CMD_GET_BUILTIN_PET_ASSETS)
}
