/** service/invoke.ts — 桌面端 Tauri 命令出口（经 dsh-tauri invoke 桥）。 */
import type { PetListItem, PetSource, PetStatus, PresetPetItem } from './pet.types'
import { invoke } from 'dsh-tauri/client'
import {
  CMD_GET_PET_STATUS,
  CMD_IMPORT_PET,
  CMD_LIST_PETS,
  CMD_LIST_PRESET_PETS,
  CMD_SET_ACTIVE_PET,
  CMD_SET_PET_ENABLED,
  CMD_SET_PET_SIZE,
} from '../constants'

export function getPetStatus(): Promise<PetStatus> {
  return invoke<PetStatus>(CMD_GET_PET_STATUS)
}

export function postPetEnabled(enabled: boolean): Promise<PetStatus> {
  return invoke<PetStatus>(CMD_SET_PET_ENABLED, { enabled })
}

export function postActivePet(id: string): Promise<PetStatus> {
  return invoke<PetStatus>(CMD_SET_ACTIVE_PET, { id })
}

export function postPetSize(size: number): Promise<PetStatus> {
  return invoke<PetStatus>(CMD_SET_PET_SIZE, { size })
}

export function getPetList(source: PetSource): Promise<PetListItem[]> {
  return invoke<PetListItem[]>(CMD_LIST_PETS, { source })
}

export function postPetImport(name: string, data: string): Promise<PetListItem> {
  return invoke<PetListItem>(CMD_IMPORT_PET, { name, data })
}

/** 预设宠物清单（`resources/preset-pets.json`；条目直连远端素材，无安装态）。 */
export function getPresetPets(): Promise<PresetPetItem[]> {
  return invoke<PresetPetItem[]>(CMD_LIST_PRESET_PETS)
}
