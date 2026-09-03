/**
 * styles/index.ts — 桌宠侧栏入口 + 设置分区样式（css-render，apply() effect 内 mount）。
 *
 * 侧栏入口按钮复刻官方 `.rtSEdW_iconButton`（appearance/color/border-radius/
 * padding/hover/focus-visible 与 data-tip 气泡），并叠加右上角绿色激活圆点；
 * 设置行布局复刻新版 dsh 客户端 SettingsRoot 的 triggerRow（flex 行 + gap，
 * 齿轮与行内图标同一行）——规则全部拆成单选择器（不依赖 data-slot 包裹层，
 * 由补丁直接给宿主加 .dshpet-settingsRow 并同步内联样式兜底）；
 * 设置分区遵循 issue #308 规范稿：页签 + 工具栏 + 描述 + 卡片列表，全部走
 * `--dsw-alias-*` 主题变量，明暗主题自适应。
 */
import { CssRender } from 'css-render'
import { PET_CLIENT_PLUGIN } from '../constants'

const cssr = CssRender()
const { c } = cssr

const style = c([
  // ── 侧栏入口：官方 iconButton 复刻（插在 .dsh-tu-settingsTrigger 右侧）──
  c('.dshpet-iconButton', {
    appearance: 'none',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    background: '0 0',
    border: '0',
    borderRadius: '7px',
    alignItems: 'center',
    padding: '6px',
    display: 'inline-flex',
    position: 'relative',
    pointerEvents: 'auto',
  }, [
    c('&:disabled', { opacity: '0.4', cursor: 'default' }),
    c('&:hover:not(:disabled)', {
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
    }),
    c('&:focus-visible', {
      outline: '2px solid var(--dsw-alias-brand-primary)',
      outlineOffset: '-1px',
    }),
  ]),
  // data-tip 气泡（同官方 iconButton 的 :after 提示位）。
  c('.dshpet-iconButton::after', {
    content: 'attr(data-tip)',
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'var(--dsw-alias-label-primary)',
    color: 'var(--dsw-alias-bg-layer-3, #fff)',
    padding: '4px 8px',
    borderRadius: '6px',
    fontSize: '12px',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 0.15s ease',
    zIndex: '10',
  }),
  c('.dshpet-iconButton:hover::after, .dshpet-iconButton:focus-visible::after', { opacity: '1' }),
  // 激活态绿色小圆点（右上角），未激活时隐藏。
  c('.dshpet-iconDot', {
    position: 'absolute',
    top: '2px',
    right: '2px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--dsw-alias-state-success-primary, #3ddc84)',
    display: 'none',
  }),
  c('.dshpet-iconButton.dshpet-iconOn .dshpet-iconDot', { display: 'block' }),

  // ── 设置行布局：复刻新版 dsh 客户端 SettingsRoot 的 triggerRow（flex 行）──
  // 旧版客户端 sidebar.settings 是通栏块级触发器，图标按钮直接插会被挤到下
  // 一行；补丁给触发器宿主加 .dshpet-settingsRow（并同步内联 display:flex 兜
  // 底），触发器占满剩余宽度、图标排右侧，行内 gap 对齐官方排布。
  c('.dshpet-settingsRow', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
  }),
  c('.dshpet-settingsRow > .dsh-tu-settingsTrigger:not(.dsh-tu-settingsTriggerRail)', {
    flex: '1 1 auto',
    width: 'auto',
    minWidth: '0',
  }),
  c('.dshpet-settingsRow > .dshpet-iconButton', {
    flex: 'none',
    marginRight: '2px',
  }),

  // ── 设置分区（settings.section）：页签 + 工具栏 + 描述 + 卡片，不自设宽度 ──
  c('.dshpet-page', {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    color: 'var(--dsw-alias-label-primary)',
  }),
  c('.dshpet-tabs', {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    flexWrap: 'wrap',
    margin: '4px 0 14px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  }),
  c('.dshpet-tabList', { display: 'flex', alignItems: 'center', gap: '16px' }),
  c('.dshpet-tabBtn', {
    appearance: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: '13px',
    lineHeight: '1.5',
    border: '0',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
    padding: '8px 0',
  }, [
    c('&:hover', { color: 'var(--dsw-alias-label-primary)' }),
  ]),
  c('.dshpet-tabBtn.dshpet-tabBtnActive', {
    borderBottomColor: 'currentColor',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: '650',
  }),
  c('.dshpet-tabTools', { display: 'flex', alignItems: 'center', gap: '6px' }),
  // —— 工具栏按钮：小型 secondary（与 .dshpet-cardAction 小号按钮一致的几何/令牌）——
  // 官方 `.zGbnIq_secondaryButton`（36px 胶囊）在本工具栏过大会挤压页签行，故取
  // 与卡片操作按钮同尺寸的小号 secondary（28px，radius 8px，12px/18px 字体），
  // 仍走 `--dsw-*` 令牌使浅/深色自适应，并保留官方共用焦点环。
  c('.dshpet-toolBtn', {
    flex: 'none',
    appearance: 'none',
    cursor: 'pointer',
    padding: '5px 10px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '12px',
    lineHeight: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    whiteSpace: 'nowrap',
  }, [
    c('&:hover:not(:disabled)', { background: 'var(--dsw-alias-interactive-bg-hover)' }),
    c('&:disabled', { opacity: '0.4', cursor: 'default' }),
    c('&:focus-visible', {
      boxShadow: '0 0 0 2px var(--dsw-alias-border-l3)',
      outline: 'none',
    }),
  ]),
  c('.dshpet-tabDesc', {
    margin: '0',
    fontSize: '13px',
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshpet-divider', {
    border: '0',
    borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
  }),
  c('.dshpet-sizeRow', { display: 'flex', alignItems: 'center', gap: '12px' }),
  c('.dshpet-sizeLabel', { flex: 'none', fontWeight: '500' }),
  c('.dshpet-sizeSlider', {
    flex: '1',
    accentColor: 'var(--dsw-alias-brand-primary)',
    cursor: 'pointer',
  }),
  c('.dshpet-hint', {
    margin: '0',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshpet-cards', { display: 'flex', flexDirection: 'column', gap: '12px' }),
  c('.dshpet-cardItem', {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 14px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    background: 'var(--dsw-alias-bg-base)',
  }),
  c('.dshpet-cardThumb', {
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
  c('.dshpet-cardThumb > img', {
    display: 'block',
    width: '100%',
    height: '100%',
  }),
  c('.dshpet-cardThumbSprite', {
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
  c('.dshpet-cardBody', {
    flex: '1',
    minWidth: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  }),
  c('.dshpet-cardName', { fontWeight: '600', fontSize: '14px', lineHeight: '20px' }),
  c('.dshpet-cardDesc', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshpet-cardAction', {
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
  c('.dshpet-cardAction.dshpet-cardActionActive', {
    borderColor: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  }),
  c('.dshpet-empty', {
    padding: '24px 16px',
    textAlign: 'center',
    fontSize: '13px',
    lineHeight: '20px',
    borderRadius: '12px',
    border: '1px dashed var(--dsw-alias-border-weak, rgba(127,127,127,0.2))',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }),
  c('.dshpet-error', {
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-danger-text, #ff7a7a))',
  }),
])

export function mountPetStyles(): () => void {
  style.mount({ id: `${PET_CLIENT_PLUGIN}-styles`, head: true })
  return () => style.unmount({ id: `${PET_CLIENT_PLUGIN}-styles` })
}
