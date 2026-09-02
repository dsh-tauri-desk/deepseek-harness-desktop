import { CssRender } from 'dsh-tauri/client'
import { SCHEDULER_CLASSES as K, STYLE_ID } from '../constants'

/**
 * styles/index.ts — 定时任务面板样式（官方控件样式复刻 + 布局补充）。
 *
 * 控件外观复刻官方 dsh 面板的样式值：ModelsSection.module.css 的
 * input / selectInput / iconButton / field / 36px 胶囊按钮，与
 * LanguageRow.module.css 的 selector（pill 触发按钮，下拉走 primitives `Menu`）。
 * 全部基于 --dsw-alias-* 令牌（浅色/深色主题自动适配），以本插件前缀类名承载，
 * 不依赖生成的 CSS module hash（docs/AGENTS.plugins.md:223 禁止）。
 * 本文件仅做布局 / 边框 / 圆角 / 填充补充，mount 只在 apply() 里经 ctx.effect 调用。
 */

const cssr = CssRender()
const { c } = cssr

const primary = 'var(--dsw-alias-label-primary)'
const secondary = 'var(--dsw-alias-label-secondary)'
const tertiary = 'var(--dsw-alias-label-tertiary)'
const dimmed = 'var(--dsw-alias-label-dimmed)'
const border = 'var(--dsw-alias-border-l2)'
const borderL3 = 'var(--dsw-alias-border-l3)'
const borderL4 = 'var(--dsw-alias-border-l4)'
const brand = 'var(--dsw-alias-brand-primary)'
const business = 'var(--dsw-alias-state-business-primary)'
const layer1 = 'var(--dsw-alias-bg-layer-1)'
const layer3 = 'var(--dsw-alias-bg-layer-3)'
const modulePlatform = 'var(--dsw-alias-bg-module-platform)'
const hover = 'var(--dsw-alias-interactive-bg-hover)'
const hoverSolid = 'var(--dsw-alias-interactive-bg-hover-solid)'
const hoverDanger = 'var(--dsw-alias-interactive-bg-hover-danger)'
const error = 'var(--dsw-alias-state-error-primary)'
const success = 'var(--dsw-alias-state-success-primary)'
const primaryFill = 'var(--dsw-alias-button-primary-fill)'
const primaryHover = 'var(--dsw-alias-button-primary-hover)'
const primaryFg = 'var(--dsw-alias-label-primary-foreground)'
const font = 'var(--dsw-font-family)'

/** selectInput 下箭头（官方 ModelsSection 的 data-uri 原样）。 */
const chevronSvg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`

/** 焦点可见：官方共用焦点环（2px border-l3 描边）。 */
const focusRing = { boxShadow: '0 0 0 2px var(--dsw-alias-border-l3)', outline: 'none' }

const styles = c([
  // —— 面板外壳 / 页头 ——
  c(`.${K.shell}`, { boxSizing: 'border-box', maxWidth: '1080px', width: '100%', margin: '0 auto', padding: '0 0 32px', color: primary, fontFamily: font, fontSize: '13px', lineHeight: '1.5' }),
  c(`.${K.top}`, { display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '12px' }),
  c(`.${K.heading} h1`, { margin: '0', fontSize: '20px', lineHeight: '28px', fontWeight: '650', letterSpacing: '-.2px' }),
  c(`.${K.heading} p`, { margin: '4px 0 0', color: tertiary, fontSize: '13px', lineHeight: '1.5' }),
  c(`.${K.toolbar}`, { display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: '8px' }),
  c(`.${K.toolbarSpacer}`, { flex: '1' }),

  // —— 搜索框（官方 input 类 + 插件补的图标定位）——
  c(`.${K.searchWrap}`, { position: 'relative', display: 'inline-flex', flex: '1', minWidth: '0', maxWidth: '280px' }),
  c(`.${K.searchWrap} .${K.input}`, { width: '100%', paddingLeft: '32px' }),
  c(`.${K.searchIcon}`, { position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: tertiary }),

  // —— Tabs ——
  c(`.${K.tabs}`, { display: 'flex', alignItems: 'center', gap: '16px', margin: '4px 0 14px', borderBottom: `1px solid ${border}` }),
  c(`.${K.tab}`, { padding: '8px 0', border: '0', borderBottom: '2px solid transparent', background: 'transparent', color: secondary, font: 'inherit', fontSize: '13px', cursor: 'pointer' }),
  c(`.${K.tab}:hover`, { color: primary }),
  c(`.${K.tabActive}`, { borderBottomColor: 'currentColor', color: primary, fontWeight: '650' }),

  c(`.${K.modal}`, { width: 'min(640px,100%) !important' }),

  // —— 任务卡片（单列；容器样式与推荐项 recs-item 一致，点击=编辑）——
  c(`.${K.cards}`, { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', listStyle: 'none' }),
  c('@media (max-width: 680px)', [c(`.${K.searchWrap}`, { maxWidth: '160px' })]),
  c(`.${K.card}`, { boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', width: '100%', minWidth: '0', height: '60px', padding: '10px 12px', border: `1px solid ${border}`, borderRadius: '10px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', lineHeight: '20px', textAlign: 'left', cursor: 'pointer', overflow: 'hidden' }),
  c(`.${K.card}:hover`, { background: hover }),
  c(`.${K.cardPaused}`, { opacity: '.6' }),
  c(`.${K.cardTitle}`, { display: 'flex', alignItems: 'center', gap: '8px', margin: '0', fontSize: '13px', lineHeight: '18px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c(`.${K.cardIcon}`, { flex: 'none', width: '16px', height: '16px', color: business }),
  c(`.${K.taskToggle}`, { flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', padding: '0', border: 'none', borderRadius: '6px', background: 'transparent', color: tertiary, cursor: 'pointer' }),
  c(`.${K.taskToggle}:hover`, { background: hover, color: primary }),
  c(`.${K.cardMeta}`, { display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }),
  c(`.${K.cardMetaText}`, { flex: '1', minWidth: '0', color: tertiary, fontSize: '12px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c(`.${K.cardMetaText} strong`, { color: secondary, fontWeight: '600' }),

  // —— 官方控件复刻：input / selectInput / textarea ——
  c(`.${K.input}`, { boxSizing: 'border-box', border: `.5px solid ${borderL4}`, width: '100%', height: '32px', font: 'inherit', background: layer1, color: primary, borderRadius: '8px', padding: '0 10px', fontSize: '14px', lineHeight: '22px' }),
  c(`select.${K.input}`, { cursor: 'pointer', maxWidth: '240px' }),
  c(`.${K.input}:focus`, { borderColor: brand, outline: 'none' }),
  c(`.${K.input}::placeholder`, { color: dimmed }),
  c(`.${K.input}:disabled`, { opacity: '.6', cursor: 'default' }),
  c(`.${K.selectInput}`, { appearance: 'none', backgroundImage: chevronSvg, backgroundPosition: 'right 12px center', backgroundRepeat: 'no-repeat', backgroundSize: '12px 12px', paddingRight: '32px' }),
  c(`.${K.textarea}`, { boxSizing: 'border-box', border: `.5px solid ${borderL4}`, width: '100%', height: 'auto', minHeight: '240px', font: 'inherit', background: layer1, color: primary, borderRadius: '8px', padding: '10px', paddingBottom: '46px', fontSize: '14px', lineHeight: '1.55', resize: 'vertical', outline: 'none' }),
  c(`.${K.textarea}:focus`, { borderColor: brand }),
  c(`.${K.textarea}::placeholder`, { color: dimmed }),

  // —— 官方控件复刻：iconButton ——
  c(`.${K.iconButton}`, { boxSizing: 'border-box', width: '28px', height: '28px', color: tertiary, cursor: 'pointer', background: 'transparent', border: 'none', borderRadius: '6px', justifyContent: 'center', alignItems: 'center', display: 'inline-flex' }),
  c(`.${K.iconButton}:hover:not(:disabled)`, { background: hover, color: primary }),
  c(`.${K.iconButton}:disabled`, { cursor: 'default', opacity: '.4' }),
  c(`.${K.iconButtonDanger}:hover:not(:disabled)`, { background: hoverDanger, color: error }),
  c(`.${K.iconButton}:focus-visible`, focusRing),

  // —— 官方控件复刻：36px 胶囊按钮（primary / secondary / danger）——
  c(`.${K.btn},.${K.btnPrimary},.${K.btnDanger}`, { boxSizing: 'border-box', height: '36px', font: 'inherit', cursor: 'pointer', border: 'none', borderRadius: '18px', justifyContent: 'center', alignItems: 'center', gap: '4px', padding: '0 14px', fontSize: '14px', lineHeight: '22px', display: 'inline-flex', whiteSpace: 'nowrap' }),
  c(`.${K.btn}`, { border: `.5px solid ${borderL3}`, color: primary, background: 'transparent' }),
  c(`.${K.btn}:not(:disabled):hover`, { background: hoverSolid }),
  c(`.${K.btnPrimary}`, { background: primaryFill, color: primaryFg, borderColor: 'transparent' }),
  c(`.${K.btnPrimary}:not(:disabled):hover`, { background: primaryHover, borderColor: 'transparent' }),
  c(`.${K.btnDanger}`, { color: error }),
  c(`.${K.btnDanger}:not(:disabled):hover`, { background: hoverDanger }),
  c(`.${K.btn}:disabled,.${K.btnPrimary}:disabled,.${K.btnDanger}:disabled`, { opacity: '.4', cursor: 'default' }),
  c(`.${K.btn}:focus-visible,.${K.btnPrimary}:focus-visible,.${K.btnDanger}:focus-visible`, focusRing),

  // —— 官方控件复刻：字段 / 下拉 pill selector（LanguageRow selector，配 primitives Menu）——
  c(`.${K.field}`, { flexDirection: 'column', gap: '2px', display: 'flex', minWidth: '0', fontSize: '13px' }),
  c(`.${K.fieldLabel}`, { color: secondary, alignItems: 'center', gap: '10px', fontSize: '12px', fontWeight: '500', lineHeight: '18px', display: 'inline-flex' }),
  c(`.${K.inline}`, { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }),
  c(`.${K.inlineSelect}`, { flex: '1', minWidth: '120px' }),
  c(`.${K.inlineSelectAuto}`, { flex: 'none', width: 'auto', minWidth: '120px' }),
  c(`.${K.composer}`, { position: 'absolute', left: '10px', bottom: '10px', display: 'flex', gap: '8px', alignItems: 'stretch' }),
  c(`.${K.promptWrap}`, { position: 'relative' }),
  c(`.${K.selector}`, { background: modulePlatform, height: '36px', font: 'inherit', color: primary, cursor: 'pointer', border: 'none', borderRadius: '18px', alignItems: 'center', gap: '12px', padding: '0 14px', fontSize: '14px', lineHeight: '22px', display: 'inline-flex', whiteSpace: 'nowrap' }),
  c(`.${K.selector}:hover`, { background: hover }),
  c(`.${K.selectorChevron}`, { flex: 'none' }),
  c(`.${K.selectorEffort}`, { color: tertiary, fontSize: '12px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' }),

  // —— 状态文案 ——
  c(`.${K.error}`, { color: error, margin: '0', fontSize: '12px', lineHeight: '18px' }),
  c(`.${K.empty}`, { margin: '0', padding: '48px 0', color: tertiary, fontSize: '13px', textAlign: 'center' }),
  c(`.${K.muted}`, { margin: '0', color: secondary, fontSize: '12px' }),

  // —— 执行记录 ——
  c(`.${K.runsToolbar}`, { display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }),
  c(`.${K.runsList}`, { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', listStyle: 'none' }),
  c(`.${K.runRow}`, { boxSizing: 'border-box', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', width: '100%', minWidth: '0', minHeight: '60px', padding: '10px 12px', border: `1px solid ${border}`, borderRadius: '10px', background: 'transparent', color: 'inherit', fontSize: '13px', lineHeight: '20px', textAlign: 'left', overflow: 'hidden' }),
  c(`.${K.runMain}`, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0', overflow: 'hidden' }),
  c(`.${K.runMeta}`, { display: 'flex', alignItems: 'center', gap: '4px', minWidth: '0', flexShrink: '0' }),
  c(`.${K.runName}`, { display: 'block', minWidth: '0', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  c(`.${K.runTime}`, { color: tertiary, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
  c(`.${K.runDelete}`, { border: 'none', background: 'transparent', color: tertiary, cursor: 'pointer', font: 'inherit', fontSize: '12px', padding: '2px 4px' }),
  c(`.${K.runDelete}:hover`, { color: error }),
  c(`.${K.runError}`, { width: '100%', margin: '0', color: error, fontSize: '12px', lineHeight: '16px', whiteSpace: 'pre-wrap' }),
  c(`.${K.chip}`, { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 10px', borderRadius: '999px', background: layer3, color: secondary, fontSize: '12px', whiteSpace: 'nowrap' }),
  c(`.${K.chip}[data-status='succeeded']`, { background: `color-mix(in srgb,${success} 12%,transparent)`, color: success }),
  c(`.${K.chip}[data-status='failed']`, { background: `color-mix(in srgb,${error} 12%,transparent)`, color: error }),
  c(`.${K.chip}[data-status='running'],.${K.chip}[data-status='queued']`, { background: `color-mix(in srgb,${business} 12%,transparent)`, color: business }),

  // —— 推荐（预置）定时任务 ——
  c(`.${K.recs}`, { marginTop: '24px' }),
  c(`.${K.recTitle}`, { margin: '0 0 10px', fontSize: '13px', lineHeight: '18px', fontWeight: '600', color: secondary }),
  c(`.${K.recList}`, { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0', padding: '0', listStyle: 'none' }),
  c(`.${K.recItem}`, { boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start', gap: '10px', width: '100%', minWidth: '0', padding: '10px 12px', border: `1px solid ${border}`, borderRadius: '10px', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '13px', lineHeight: '20px', textAlign: 'left', cursor: 'pointer' }),
  c(`.${K.recItem}:hover`, { background: hover }),
  c(`.${K.recIcon}`, { flex: 'none', display: 'inline-flex', marginTop: '2px', fontSize: '16px' }),
  c(`.${K.recBody}`, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' }),
  c(`.${K.recName}`, { color: primary, fontSize: '13px', lineHeight: '18px', fontWeight: '500' }),
  c(`.${K.recName} strong`, { color: secondary, fontWeight: '600' }),
  c(`.${K.recPrompt}`, { color: tertiary, fontSize: '12px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
])

export function mountSchedulerStyles(): () => void {
  if (typeof document === 'undefined')
    return () => {}
  if (cssr.find(STYLE_ID) !== null)
    return () => {}
  styles.mount({ id: STYLE_ID, head: true })
  return () => styles.unmount({ id: STYLE_ID })
}
