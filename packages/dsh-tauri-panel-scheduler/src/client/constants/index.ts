/** client/constants/index.ts — 客户端共享常量（跨 half 协议常量见 shared/constants.ts）。 */

import { SCHEDULER_PLUGIN_NAME } from '../../shared/constants'

export { SCHEDULER_API_PREFIX as API_PREFIX, SCHEDULER_PLUGIN_NAME as PLUGIN_ID } from '../../shared/constants'

export const LOCALE_NAMESPACE = SCHEDULER_PLUGIN_NAME

export const PANEL_PROTOCOL_NAME = 'panel.protocol'
export const PANEL_SLOT_NAME = 'sidebar.panel.action'
export const PANEL_ID = 'dsh-tauri-panel-scheduler'
export const PANEL_ACTION_ID = 'dsh-tauri-panel-scheduler.action'
export const PANEL_ACTION_ORDER = 30
export const PANEL_ACTION_PRIORITY = 0

export const STYLE_ID = 'dsh-tauri-panel-scheduler-styles'

export const STYLES_EFFECT = `${SCHEDULER_PLUGIN_NAME}: styles`
export const PANEL_EFFECT = `${SCHEDULER_PLUGIN_NAME}: panel slot`

/** 客户端轮询刷新间隔（执行记录 / 下次运行时间跟随）。 */
export const REFRESH_INTERVAL_MS = 5_000
/** 协议未就绪时的重试间隔。 */
export const PROTOCOL_RETRY_MS = 50

/**
 * css-render class 前缀（值仅用于样式命名，不作为协议）。
 *
 * 遵循 dsh-tauri-session 的 SESSION_CLASSES 约定：插件前缀 + 语义名，
 * 控件类（input / select-input / icon-button / selector / btn / field）复刻
 * 官方 ModelsSection.module.css 与 LanguageRow.module.css 的样式值，
 * 全部基于 --dsw-alias-* 令牌（浅色/深色主题自动适配），不依赖生成的
 * CSS module hash（docs/AGENTS.plugins.md 禁止）。
 */
export const SCHEDULER_CLASSES = {
  // —— 面板外壳 / 页头 ——
  shell: 'dsh-tauri-panel-scheduler-shell',
  top: 'dsh-tauri-panel-scheduler-top',
  heading: 'dsh-tauri-panel-scheduler-heading',
  toolbar: 'dsh-tauri-panel-scheduler-toolbar',
  toolbarSpacer: 'dsh-tauri-panel-scheduler-toolbar-spacer',
  searchWrap: 'dsh-tauri-panel-scheduler-search-wrap',
  searchIcon: 'dsh-tauri-panel-scheduler-search-icon',
  banner: 'dsh-tauri-panel-scheduler-banner',

  // —— Tabs ——
  tabs: 'dsh-tauri-panel-scheduler-tabs',
  tab: 'dsh-tauri-panel-scheduler-tab',
  tabActive: 'dsh-tauri-panel-scheduler-tab-active',

  // —— 任务卡片 ——
  cards: 'dsh-tauri-panel-scheduler-cards',
  card: 'dsh-tauri-panel-scheduler-card',
  cardPaused: 'dsh-tauri-panel-scheduler-card-paused',
  cardTitle: 'dsh-tauri-panel-scheduler-card-title',
  cardIcon: 'dsh-tauri-panel-scheduler-card-icon',
  taskToggle: 'dsh-tauri-panel-scheduler-task-toggle',
  cardMeta: 'dsh-tauri-panel-scheduler-card-meta',
  cardMetaText: 'dsh-tauri-panel-scheduler-card-meta-text',

  // —— 执行记录 ——
  runsList: 'dsh-tauri-panel-scheduler-runs-list',
  runsToolbar: 'dsh-tauri-panel-scheduler-runs-toolbar',
  runRow: 'dsh-tauri-panel-scheduler-run-row',
  runMain: 'dsh-tauri-panel-scheduler-run-main',
  runMeta: 'dsh-tauri-panel-scheduler-run-meta',
  runName: 'dsh-tauri-panel-scheduler-run-name',
  runTime: 'dsh-tauri-panel-scheduler-run-time',
  runDelete: 'dsh-tauri-panel-scheduler-run-delete',
  runError: 'dsh-tauri-panel-scheduler-run-error',
  chip: 'dsh-tauri-panel-scheduler-chip',

  // —— 文案状态 ——
  empty: 'dsh-tauri-panel-scheduler-empty',
  muted: 'dsh-tauri-panel-scheduler-muted',
  error: 'dsh-tauri-panel-scheduler-error',

  // —— 推荐列表 ——
  recs: 'dsh-tauri-panel-scheduler-recs',
  recTitle: 'dsh-tauri-panel-scheduler-recs-title',
  recList: 'dsh-tauri-panel-scheduler-recs-list',
  recItem: 'dsh-tauri-panel-scheduler-recs-item',
  recIcon: 'dsh-tauri-panel-scheduler-recs-icon',
  recBody: 'dsh-tauri-panel-scheduler-recs-body',
  recName: 'dsh-tauri-panel-scheduler-recs-name',
  recPrompt: 'dsh-tauri-panel-scheduler-recs-prompt',

  // —— 官方控件复刻（ModelsSection / LanguageRow 样式值）——
  field: 'dsh-tauri-panel-scheduler-field',
  fieldLabel: 'dsh-tauri-panel-scheduler-field-label',
  inline: 'dsh-tauri-panel-scheduler-inline',
  inlineSelect: 'dsh-tauri-panel-scheduler-inline-select',
  inlineSelectAuto: 'dsh-tauri-panel-scheduler-inline-select-auto',
  composer: 'dsh-tauri-panel-scheduler-composer',
  promptWrap: 'dsh-tauri-panel-scheduler-prompt-wrap',
  input: 'dsh-tauri-panel-scheduler-input',
  selectInput: 'dsh-tauri-panel-scheduler-select-input',
  textarea: 'dsh-tauri-panel-scheduler-textarea',
  iconButton: 'dsh-tauri-panel-scheduler-icon-button',
  iconButtonDanger: 'dsh-tauri-panel-scheduler-icon-button-danger',
  btn: 'dsh-tauri-panel-scheduler-btn',
  btnPrimary: 'dsh-tauri-panel-scheduler-btn-primary',
  btnDanger: 'dsh-tauri-panel-scheduler-btn-danger',
  selector: 'dsh-tauri-panel-scheduler-selector',
  selectorChevron: 'dsh-tauri-panel-scheduler-selector-chevron',
  selectorEffort: 'dsh-tauri-panel-scheduler-selector-effort',

  modal: 'dsh-tauri-panel-scheduler-modal',
} as const
