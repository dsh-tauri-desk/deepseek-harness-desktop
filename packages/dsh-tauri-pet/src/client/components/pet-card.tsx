import type { ReactElement } from 'react'
import type { PetCardProps } from './pet-card.types'
import { useMountStyle } from 'dsh-tauri-ui/client'
import { PET_CARD_STYLES_ID } from '../constants'
import petCardStyle from './pet-card.cssr'

/** 桌宠卡片：缩略图 + 名称/描述 + 单个动作按钮（启用 / 选择 / 取消选择）。 */
export function PetCard(props: PetCardProps): ReactElement {
  useMountStyle(petCardStyle, PET_CARD_STYLES_ID)
  const actionClassName = props.active
    ? 'dshp-pet__card-action dshp-pet__card-actionActive'
    : 'dshp-pet__card-action'
  const thumbnailClassName = props.thumbnailType === 'spritesheet'
    ? 'dshp-pet__card-thumb dshp-pet__card-thumbSprite'
    : 'dshp-pet__card-thumb'

  return (
    <div className="dshp-pet__card-item">
      {props.thumbnail
        ? props.thumbnailType === 'spritesheet'
          ? (
              <span className={thumbnailClassName} aria-hidden="true">
                <img src={props.thumbnail} alt="" aria-hidden="true" />
              </span>
            )
          : <img className={thumbnailClassName} src={props.thumbnail} alt="" aria-hidden="true" />
        : <div className="dshp-pet__card-thumb dshp-pet__card-thumbPlaceholder" aria-hidden="true">PET</div>}
      <span className="dshp-pet__card-body">
        <span className="dshp-pet__card-nameRow">
          <span className="dshp-pet__card-name">{props.name}</span>
        </span>
        {props.desc ? <span className="dshp-pet__card-desc">{props.desc}</span> : null}
      </span>
      <span className="dshp-pet__card-actions">
        <button
          type="button"
          className={actionClassName}
          disabled={props.disabled}
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      </span>
    </div>
  )
}
