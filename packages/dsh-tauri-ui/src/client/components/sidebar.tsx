import type { ReactElement } from 'react'
import type { SettingsSidebarProps } from '../types'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
/**
 * sidebar.tsx — shell.overlay 里的设置侧边栏（id 'dsh-tauri-ui-settings'）。
 *
 * 布局即需求方 ASCII：整窗左侧停靠 —— 左栏（← 返回应用 / 🔍 搜索设置…
 * / 设置项导航，只过滤左栏列表）+ 右侧内容区。内容区渲染当前激活分区：
 *
 *   <SlotOutlet slotKey={SETTINGS_SECTION_SLOT} ownerProps={{ close }} opts={{ only: activeId }} />
 *
 * 与官方 SettingsPanel 的渲染调用逐参数一致（owner={close}，only=active）。
 * shell.overlay 是 list/root 且层本身 click-through，本条目 opt-in pointer
 * events。Esc 与“返回应用”都走 closeSettings()；打开时聚焦搜索框。
 *
 * 视觉对齐官方（用户反馈 m00308/m00310）：
 *   1. 左栏背景 = 官方 sidebar（.hHd-Xa_root）的 --dsw-specific-sidebar-fill；
 *   2. 内容区背景 = 主界面（.wSkVaW_root / .wSkVaW_scrollBody）的 --dsw-alias-bg-base；
 *   3. 左栏宽度可拖拽调整（镜像官方 DragHandle：pointer capture + rAF 节流），
 *      开通与官方一致的合约区间 clamp [264, 420]（官方默认 280、关闭即忘）；
 *      打开时按官方 sidebar 槽（[data-slot="sidebar"]）的实际渲染宽度做一次同步。
 *   4. 内容区宽度与主界面 hero 行一致：
 *      min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)
 *      （这些 --dsh-composer-* 变量定义域在官方 .wSkVaW_root 容器，overlay 在其外，
 *      由本组件在根节点自带相同定义），左右留空与主界面对齐。
 *   无“最小化/折叠 rail”模式：返回应用/Esc 即整体隐藏（与 codex 同思路）。
 *
 * 职责边界：拖拽交互 → hooks/use-rail-drag.ts；下层/外部表面隐藏 →
 * dom/settings-obstructions.ts；本文件只保留组件状态 + JSX + 打开期副作用。
 */
import { useEffect, useRef } from 'react'
import {
  SETTINGS_SECTION_SLOT,
} from '../constants'
import { concealSettingsObstructions } from '../dom/settings-obstructions'
import { useSettingsSectionRows } from '../hooks/sections'
import { useRailDrag } from '../hooks/use-rail-drag'
import { settingsText, useSettingsLocale } from '../locales'
import {
  clampRailWidth,
  closeSettings,
  RAIL_WIDTH_DEFAULT,
  selectSection,
  setRailWidth,
  settingsStore,
  useSettingsUi,
} from '../store'
import { ArrowRight } from './icons'
import { SettingsNavIcon } from './nav-icon'

/**
 * 侧边栏组件：整窗 docked 左栏 + 右侧官方设置分区内容。
 * @param _props - 标准钩子（当前未消费 useSessions，保留以符合合成 props）。
 * @returns 侧边栏，或 null（未打开时 shell.overlay 条目不占位、不挡点击）。
 */
export function SettingsSidebar(_props: SettingsSidebarProps): ReactElement | null {
  const ui = useSettingsUi()
  const rows = useSettingsSectionRows()
  useSettingsLocale()
  const searchRef = useRef<HTMLInputElement>(null)
  const { dragging, onHandlePointerDown } = useRailDrag()

  // Esc 关闭（仅打开期间挂载监听，与官方 SettingsPanel 同生命周期）。
  useEffect(() => {
    if (!ui.open)
      return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape')
        closeSettings()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [ui.open])

  // 打开时聚焦搜索框；并按官方 sidebar 槽的实际渲染宽度同步左栏宽度（item 3）。
  useEffect(() => {
    if (!ui.open)
      return
    const el = document.querySelector('[data-slot="sidebar"]')
    const width = el?.getBoundingClientRect().width
    if (typeof width === 'number' && width >= 264)
      setRailWidth(clampRailWidth(width))
    searchRef.current?.focus()
  }, [ui.open])

  // 自定义主题可能让设置页背景半透明，独立挂载到 body 的第三方 overlay 也可能
  // 建立自己的层叠上下文。设置打开期间隐藏并禁用这些下层/外部表面，关闭时由
  // disposer 精确恢复插件或主题原先拥有的内联状态。
  useEffect(() => {
    if (!ui.open)
      return
    return concealSettingsObstructions()
  }, [ui.open])

  if (!ui.open)
    return null

  const railWidth = ui.railWidth ?? RAIL_WIDTH_DEFAULT
  const query = ui.query.trim().toLowerCase()
  const visible = query
    ? rows.filter(
        row =>
          row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query),
      )
    : rows
  const activeId = visible.some(row => row.id === ui.activeId)
    ? ui.activeId
    : visible[0]?.id

  return (
    <div className="dsh-tu-settingsRoot" data-slot-sidebar="dsh-tauri-ui">
      <div
        className="dsh-tu-settingsRail"
        style={{ '--dsh-settings-rail-width': `${railWidth}px` } as React.CSSProperties}
      >
        <button
          type="button"
          className="dsh-tu-settingsBack"
          onClick={() => closeSettings()}
        >
          <ArrowRight />
          {settingsText('back')}
        </button>
        <input
          ref={searchRef}
          className="dsh-tu-settingsSearch"
          value={ui.query}
          placeholder={settingsText('search')}
          aria-label={settingsText('search')}
          onChange={event =>
            settingsStore.set(state => ({ ...state, query: event.target.value }))}
        />
        <nav className="dsh-tu-settingsNav" aria-label={settingsText('settings')}>
          {visible.map(row => (
            <button
              key={row.id}
              type="button"
              className={`dsh-tu-settingsNavItem${row.id === activeId ? ' dsh-tu-settingsNavItemActive' : ''}`}
              aria-current={row.id === activeId ? 'true' : undefined}
              onClick={() => selectSection(row.id)}
            >
              <SettingsNavIcon id={row.id} />
              <span className="dsh-tu-settingsNavLabel">{row.label}</span>
            </button>
          ))}
          {visible.length === 0 && <div className="dsh-tu-settingsEmpty">{settingsText('noResults')}</div>}
        </nav>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={settingsText('settings')}
        className={`dsh-tu-settingsHandle${dragging ? ' dsh-tu-settingsHandleDragging' : ''}`}
        onPointerDown={onHandlePointerDown}
      />
      <div className="dsh-tu-settingsContentOuter">
        <div className="dsh-tu-settingsContentInner">
          {activeId !== undefined && (
            <SlotOutlet
              slotKey={SETTINGS_SECTION_SLOT}
              ownerProps={{ close: () => closeSettings() }}
              opts={{ only: activeId }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
