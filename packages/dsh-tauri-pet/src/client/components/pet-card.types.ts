/** 桌宠卡片（预设 / Chat / Codex 三类共用的展示单元）属性。 */
export interface PetCardProps {
  actionLabel: string
  active: boolean
  desc: string
  disabled: boolean
  name: string
  onAction: () => void
  thumbnail?: string
  thumbnailType?: 'gif' | 'spritesheet'
}
