/** 桌宠卡片样式（仅卡片面；页签/工具栏见 pet-settings.cssr.ts）。 */
import { cssr } from 'dsh-tauri-ui/client'

const { c } = cssr

export default c([
  c('.dshp-pet__cards', { display: 'flex', flexDirection: 'column', gap: '12px' }),
  c('.dshp-pet__card-item', {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 14px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    background: 'var(--dsw-alias-bg-base)',
  }),
  c('.dshp-pet__card-thumb', {
    flex: 'none',
    width: '56px',
    height: '56px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '28px',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)',
    overflow: 'hidden',
    objectFit: 'cover',
  }),
  c('.dshp-pet__card-thumb > img', {
    display: 'block',
    width: '100%',
    height: '100%',
  }),
  // 精灵图缩略图：8 列 × 11 行的雪碧图只露出左上角一帧。
  c('.dshp-pet__card-thumbSprite', {
    position: 'relative',
  }, [
    c('& > img', {
      position: 'absolute',
      width: '800%',
      height: '1100%',
      maxWidth: 'none',
      objectFit: 'fill',
      left: '0',
      top: '0',
    }),
  ]),
  c('.dshp-pet__card-body', {
    flex: '1',
    minWidth: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  }),
  c('.dshp-pet__card-nameRow', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: '0',
  }),
  c('.dshp-pet__card-name', {
    fontWeight: '600',
    fontSize: '14px',
    lineHeight: '20px',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  c('.dshp-pet__card-desc', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshp-pet__card-actions', {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }),
  c('.dshp-pet__card-action', {
    flex: 'none',
    appearance: 'none',
    cursor: 'pointer',
    padding: '5px 14px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    lineHeight: '18px',
  }, [
    c('&:hover:not(:disabled)', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
    c('&:disabled', { opacity: '0.4', cursor: 'default' }),
  ]),
  c('.dshp-pet__card-action.dshp-pet__card-actionActive', {
    borderColor: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  }),
])
