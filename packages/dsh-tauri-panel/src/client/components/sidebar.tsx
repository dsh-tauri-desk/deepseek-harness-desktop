import type { CSSProperties, ReactElement } from 'react'
import type { SidebarRootProps } from '../types'
import { SlotOutlet } from '@deepseek-ai/dsh-client-ui-renderer'
import { useEffect, useRef, useState } from 'react'
import { COLLAPSE_SETTLE_MS, PANEL_CLASSES, PANEL_DATA_ATTRIBUTES, SCROLLBAR_LINGER_MS } from '../constants'
import { ChatOutline, FishMark } from './icons'

/**
 * components/sidebar.tsx — sidebar 槽整槽替换的克隆组件（priority -1 shadow 官方
 * ui-sidebar）；安装器见 register/sidebar.ts。
 *
 * 结构为官方 SidebarRoot（dsh-client-ui-sidebar 0.1.1-rc.2）的克隆，改动点：
 *   - logoRow 高度 60px → 32px、底部间距 8px → 4px（需求①②）；
 *   - 「新会话」按钮从 logoRow 下方移入**面板区**（需求③），样式改为
 *     workspace 菜单项行样式（需求④，镜像官方 Rows.module.css .sessionRow）；
 *   - 面板区 = 新会话菜单项 + 第三方功能项（槽 `sidebar.panel.action`，
 *     list/root，本条目 children 声明，协议⑤，见 PROTOCOL.md）。
 *
 * 渲染官方子槽（brand.mark/brand.name/workspaces/footer.action/settings）一律
 * 走 <SlotOutlet>（无 children 所有权检查）：官方条目仍 live（被 shadow），
 * 其 children 声明与 locale 注册继续生效；本条目**只**声明新增槽
 * sidebar.panel.action（子槽 key 全局唯一，绝不重声明官方子槽）。
 *
 * 交互行为镜像官方：折叠 settled（COLLAPSE_SETTLE_MS=150）→ wide 判定、
 * rail-in/fading 动画类、滚动条 linger（quietBars）。
 */

/** 简易 classnames 拼接。 */
function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 克隆的 SidebarRoot：紧凑 logoRow + 面板区 + 官方子槽透传。 */
export function SidebarRootClone({ collapsed, width, startSession, toggleSidebar, t }: SidebarRootProps): ReactElement {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    setSettled(false)
    const timer = window.setTimeout(() => {
      setSettled(true)
    }, COLLAPSE_SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [collapsed])

  const wide = !collapsed || !settled
  const lastWideWidth = useRef(width)
  if (!collapsed)
    lastWideWidth.current = width
  const everWide = useRef(!collapsed)
  if (!collapsed)
    everWide.current = true

  // 滚动条 linger：指针进入取消计时，离开后 2s 把滚动条 thumb 变透明。
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined)
      return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }

  return (
    <div
      className={cx(
        PANEL_CLASSES.root,
        !wide && PANEL_CLASSES.collapsed,
        !wide && everWide.current && PANEL_CLASSES.railIn,
        collapsed && wide && PANEL_CLASSES.fading,
        !pointerInside && PANEL_CLASSES.quietBars,
        wide && PANEL_CLASSES.wide,
      )}
      {...{ [PANEL_DATA_ATTRIBUTES.sidebar]: '' }}
      style={wide ? { '--dshp-width': `${collapsed ? lastWideWidth.current : width}px` } as CSSProperties : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => {
        armLinger()
      }}
    >
      <div className={PANEL_CLASSES.logoRow}>
        {wide && (
          <button
            type="button"
            className={PANEL_CLASSES.brand}
            aria-label={t('session.new.label')}
            onClick={() => {
              console.warn('[dsh-tauri-panel] new session requested', { source: 'brand' })
              try {
                startSession()
              }
              catch (error) {
                console.error('[dsh-tauri-panel] new session failed', error)
              }
            }}
          >
            <span className={PANEL_CLASSES.brandIdentity} aria-hidden="true">
              <span className={PANEL_CLASSES.brandMark}>
                <SlotOutlet
                  slotKey="sidebar.brand.mark"
                  ownerProps={{ size: 24 }}
                  opts={{ fallback: <FishMark size={24} /> }}
                />
              </span>
              <span className={PANEL_CLASSES.brandName}>
                <SlotOutlet
                  slotKey="sidebar.brand.name"
                  ownerProps={{}}
                  opts={{ fallback: <span className={PANEL_CLASSES.fallbackBrandName}>DSH Local Build</span> }}
                />
              </span>
            </span>
          </button>
        )}
        <button
          type="button"
          className={`${PANEL_CLASSES.iconButton} ${PANEL_CLASSES.toggle}`}
          aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
          title={collapsed ? t('toggle.open') : t('toggle.collapse')}
          onClick={() => toggleSidebar()}
        >
          {!wide && (
            <span className={PANEL_CLASSES.railMark} aria-hidden="true">
              <SlotOutlet
                slotKey="sidebar.brand.mark"
                ownerProps={{ size: 24 }}
                opts={{ fallback: <FishMark size={24} /> }}
              />
            </span>
          )}
        </button>
      </div>
      <div className={PANEL_CLASSES.panelArea}>
        <button
          type="button"
          className={`${PANEL_CLASSES.menuItem} ${PANEL_CLASSES.newSession}`}
          title={t('session.new.label')}
          onClick={() => {
            console.warn('[dsh-tauri-panel] new session requested', { source: 'menu' })
            try {
              startSession()
            }
            catch (error) {
              console.error('[dsh-tauri-panel] new session failed', error)
            }
          }}
        >
          <span className={PANEL_CLASSES.menuItemIcon}><ChatOutline size={wide ? 14 : 18} /></span>
          <span className={PANEL_CLASSES.menuItemLabel}>{t('session.new')}</span>
        </button>
        <SlotOutlet slotKey="sidebar.panel.action" ownerProps={{ wide }} />
      </div>

      <div className={PANEL_CLASSES.regionArea}>
        <SlotOutlet
          slotKey="sidebar.workspaces"
          ownerProps={{
            wide,
            expandSidebar: () => {
              if (collapsed)
                toggleSidebar()
            },
          }}
        />
      </div>

      <div className={PANEL_CLASSES.footArea}>
        <div className={PANEL_CLASSES.footerActions}>
          <SlotOutlet slotKey="sidebar.footer.action" ownerProps={{ wide }} />
        </div>
        <div className={PANEL_CLASSES.settingsArea}>
          <SlotOutlet slotKey="sidebar.settings" ownerProps={{ wide }} />
        </div>
      </div>
    </div>
  )
}
