import type { PetAsset, PetListItem, PetSource, PetStatus, PresetPetItem } from '../types'
import { invokeBridgedTauri } from 'dsh-tauri/client'
import {
  CMD_GET_PET_ASSET,
  CMD_GET_PET_STATUS,
  CMD_HIDE_PET,
  CMD_IMPORT_PET,
  CMD_LIST_PETS,
  CMD_LIST_PRESET_PETS,
  CMD_SET_ACTIVE_PET,
  CMD_SET_PET_ENABLED,
  CMD_SET_PET_SIZE,
  CMD_SHOW_PET,
} from '../constants'

export function fetchPetStatus(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_GET_PET_STATUS)
}

export function setPetEnabled(enabled: boolean): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_ENABLED, { enabled })
}

export function setActivePet(id: string): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_ACTIVE_PET, { id })
}

export function setPetSize(size: number): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SET_PET_SIZE, { size })
}

export function showPet(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_SHOW_PET)
}

export function hidePet(): Promise<PetStatus> {
  return invokeBridgedTauri<PetStatus>(CMD_HIDE_PET)
}

export function fetchPetList(source: PetSource): Promise<PetListItem[]> {
  return invokeBridgedTauri<PetListItem[]>(CMD_LIST_PETS, { source })
}

export function fetchPetAsset(id: string): Promise<PetAsset> {
  return invokeBridgedTauri<PetAsset>(CMD_GET_PET_ASSET, { id })
}

export function importPet(name: string, data: string): Promise<PetListItem> {
  return invokeBridgedTauri<PetListItem>(CMD_IMPORT_PET, { name, data })
}

/** 预设宠物清单（`resources/preset-pets.json`；条目直连远端素材，无安装态）。 */
export function fetchPresetPets(): Promise<PresetPetItem[]> {
  return invokeBridgedTauri<PresetPetItem[]>(CMD_LIST_PRESET_PETS)
}
