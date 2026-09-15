import type { PetActionResult } from '../service/pet.types'

/** settings.section 槽位注入给设置分区的属性。 */
export interface PetSettingsProps {
  close?: () => void
  onCreate: (close?: () => void) => Promise<PetActionResult>
}
