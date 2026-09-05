/**
 * dom/sidebar-icon.ts — 侧栏「桌宠入口」DOM 补丁。
 *
 * 像 dataelement/dsh-desktop 一样往侧栏塞图标：入口是 `.sidebar.settings`
 * 容器（dsh-tauri-ui 的设置触发器所在处）的子元素——紧贴 `.dsh-tu-settingsTrigger`
 * 右侧的原生按钮，样式复刻官方 `.rtSEdW_iconButton`（见 styles 的
 * .dshpet-iconButton）。按钮有「未选择/激活」两态：未选择任何宠物时（桌宠尚未
 * 启用）点击只提示「未选择宠物，请在设置页选择你的宠物」，不改变启用状态；
 * 已选择宠物后点击即在桌面端切换桌宠启用状态，不弹任何面板（设置走
 * settings.section 页）。
 *
 * 挂载策略参照 dsh-tauri-session 的 workspace-patch：MutationObserver 监听
 * document.body，侧栏就绪后插入并持续看护（React 重渲染容器后自动补插）；
 * guard 属性 + 位置校验防止重复插入与死循环。
 */
import { PET_ICON_ATTRIBUTE, PET_ICON_RETRY_MAX, PET_ICON_RETRY_MS, PET_SETTINGS_ROW_CLASS, SETTINGS_TRIGGER_SELECTOR, SIDEBAR_SELECTOR } from '../constants'
import { text } from '../locales'
import { fetchPetStatus, hidePet, setPetEnabled, showPet } from '../service/pet'
import { beginPetStatusFetch, commitPetStatusFetch, getPetUiSnapshot, setPetStatus, subscribePetUi } from '../store'

/** 入口图标（爪印，currentColor 跟随官方 iconButton 悬停变色）。 */
const PET_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 13.5c-2.7 0-5.5 2-5.5 4.3 0 1.4 1 2.2 2.3 2.2 1 0 1.9-.6 3.2-.6s2.2.6 3.2.6c1.3 0 2.3-.8 2.3-2.2 0-2.3-2.8-4.3-5.5-4.3z"/><path d="M7.3 8.1c-1 .1-1.8 1.2-1.7 2.5.1 1.2 1 2.1 2 2 .9-.1 1.7-1.2 1.6-2.4-.1-1.2-1-2.2-1.9-2.1z"/><path d="M12 4.5c-1.1 0-2 1.1-2 2.5s.9 2.5 2 2.5 2-1.1 2-2.5-.9-2.5-2-2.5z"/><path d="M16.7 8.1c-.9-.1-1.8.9-1.9 2.1-.1 1.2.7 2.3 1.6 2.4 1 .1 1.9-.8 2-2 .1-1.3-.7-2.4-1.7-2.5z"/><path d="M4.8 12.3c-.8.3-1.2 1.4-.9 2.4.3 1 1.2 1.6 2 1.3.8-.3 1.1-1.4.8-2.4-.3-1-1.1-1.6-1.9-1.3z"/><path d="M19.2 12.3c-.8-.3-1.6.3-1.9 1.3-.3 1 0 2.1.8 2.4.8.3 1.7-.3 2-1.3.3-1-.1-2.1-.9-2.4z"/></svg>'

/** 未选择宠物提示展示时长（ms）。 */
const NO_PET_HINT_MS = 2600

/** 未决的未选择提示计时器（单按钮场景，重复点击先取消再重排）。 */
let hintTimer: ReturnType<typeof setTimeout> | undefined

/** 桌宠是否已选择（启用即视为已选择；未启用=未选择，点击只提示）。 */
function petSelected(): boolean {
  return Boolean(getPetUiSnapshot().status?.enabled)
}

/**
 * 切换桌宠启用状态（入口按钮点击；已选择宠物后启用，失败仅记录，设置页内有
 * 完整错误展示）。
 */
async function togglePetEnabled(): Promise<void> {
  const current = getPetUiSnapshot().status
  const enabled = Boolean(current?.enabled)
  const visible = Boolean(current?.visible)
  try {
    const nextStatus = !enabled
      ? await setPetEnabled(true)
      : visible
        ? await hidePet()
        : await showPet()
    setPetStatus(nextStatus)
  }
  catch (error) {
    console.error('[dsh-tauri-pet] sidebar icon toggle failed:', error)
  }
}

/** 点击未选择宠物时短暂展示「请在设置页选择你的宠物」提示。 */
function flashNoPetHint(button: HTMLButtonElement): void {
  // 取消上一个未决提示：提示窗口内再次点击只重启计时，不叠加多个 timer；
  // 恢复时写死基础 label（text('name')），而不是读回此刻的 data-tip——否则
  // 第二次点击后恢复的是提示文本本身，tooltip 会永久卡在「未选择宠物…」。
  if (hintTimer !== undefined)
    window.clearTimeout(hintTimer)
  button.setAttribute('data-tip', text('noPetSelected'))
  button.classList.add('dshpet-iconHint')
  hintTimer = window.setTimeout(() => {
    hintTimer = undefined
    button.classList.remove('dshpet-iconHint')
    button.setAttribute('data-tip', text('name'))
  }, NO_PET_HINT_MS)
}

/** 创建入口按钮（绿点常驻 DOM，用 aria-pressed + 类名表达两态）。 */
function createPetIconButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dshpet-iconButton'
  button.setAttribute(PET_ICON_ATTRIBUTE, '1')
  button.setAttribute('data-tip', text('name'))
  button.setAttribute('aria-label', text('name'))
  button.innerHTML = `${PET_ICON_SVG}<span class="dshpet-iconDot" aria-hidden="true" />`
  button.addEventListener('click', () => {
    // 未选择宠物：只提示，不改变启用状态（选择走设置页）。
    if (!petSelected()) {
      flashNoPetHint(button)
      return
    }
    void togglePetEnabled()
  })
  return button
}

/** 按共享状态缓存同步按钮两态（绿点显隐 + aria-pressed）。 */
function syncIconState(button: HTMLButtonElement): void {
  const status = getPetUiSnapshot().status
  const active = Boolean(status?.enabled && status?.visible)
  button.classList.toggle('dshpet-iconOn', active)
  button.setAttribute('aria-pressed', String(active))
}

/**
 * 安装侧栏入口补丁。返回卸载函数（移除按钮、断开观察器与订阅）。
 * 桌宠状态缓存在这里初始化拉取一次；此后由设置页与按钮自身的切换写入。
 */
export function installSidebarPetIcon(): () => void {
  if (typeof document === 'undefined')
    return () => {}

  const button = createPetIconButton()
  /** 当前打过设置行类的宿主（卸载时移除，React 重渲染换宿主时随旧节点废弃）。 */
  let rowHost: HTMLElement | undefined
  /** 上一次做过内联宽度修正的触发器（折叠态/卸载时撤销）。 */
  let patchedTrigger: HTMLElement | undefined
  /** 上次修正时触发器是否为折叠态（Rail），状态翻转时需重写内联样式。 */
  let patchedRail: boolean | undefined

  const unsubscribe = subscribePetUi(() => syncIconState(button))
  const revision = beginPetStatusFetch()
  void fetchPetStatus()
    .then((status) => {
      if (getPetUiSnapshot().status === null)
        commitPetStatusFetch(revision, status)
    })
    .catch(error => console.error('[dsh-tauri-pet] fetchPetStatus failed:', error))
  syncIconState(button)

  /**
   * 把触发器宿主立成 flex 行（复刻新版 dsh 客户端 SettingsRoot 的 triggerRow）。
   * 除行类 + CSS 规则外再写一份内联样式兜底：CSS 可能被加载顺序/特异性盖过
   * （表现为图标仍被挤到下一行），而 React 对未声明 style 的节点不会清除外部
   * 内联样式；折叠态（Rail 圆形按钮）保持定宽，不做拉伸修正。
   */
  function applyRowStyles(host: HTMLElement, trigger: HTMLElement): void {
    const rail = trigger.classList.contains('dsh-tu-settingsTriggerRail')
    if (host === rowHost && trigger === patchedTrigger && rail === patchedRail)
      return
    host.classList.add(PET_SETTINGS_ROW_CLASS)
    host.style.display = 'flex'
    host.style.alignItems = 'center'
    host.style.gap = '8px'
    host.style.width = '100%'
    if (rail) {
      trigger.style.removeProperty('flex')
      trigger.style.removeProperty('width')
      trigger.style.removeProperty('min-width')
    }
    else {
      trigger.style.flex = '1 1 auto'
      trigger.style.width = 'auto'
      trigger.style.minWidth = '0'
    }
    rowHost = host
    patchedTrigger = trigger
    patchedRail = rail
  }

  /**
   * 看护入口按钮：设置触发器就绪且按钮不在其右侧时（首次挂载 / React 重渲染
   * 丢弃）重新插入；同时把触发器宿主立成 flex 行，保证图标与齿轮同行排布。
   */
  function ensurePlaced(): void {
    const trigger = document.querySelector<HTMLElement>(SETTINGS_TRIGGER_SELECTOR)
    if (!trigger?.parentElement)
      return
    applyRowStyles(trigger.parentElement, trigger)
    if (button.isConnected && button.previousElementSibling === trigger)
      return
    trigger.after(button)
    syncIconState(button)
  }

  function scan(): void {
    // 侧栏未就绪时静默跳过（由重试计时器兜底），就绪后交由观察器看护。
    if (!document.querySelector(SIDEBAR_SELECTOR))
      return
    ensurePlaced()
  }

  const observer = new MutationObserver(scan)
  let timer: ReturnType<typeof setInterval> | undefined
  let tries = 0
  /** 首次挂载：侧栏就绪后开始观察并执行首轮扫描；未就绪时轮询重试。 */
  function attach(): boolean {
    if (!document.querySelector(SIDEBAR_SELECTOR))
      return false
    observer.observe(document.body, { childList: true, subtree: true })
    scan()
    return true
  }

  if (!attach()) {
    timer = setInterval(() => {
      if (attach() || ++tries > PET_ICON_RETRY_MAX)
        clearInterval(timer)
    }, PET_ICON_RETRY_MS)
  }

  return () => {
    observer.disconnect()
    unsubscribe()
    button.remove()
    if (rowHost) {
      rowHost.classList.remove(PET_SETTINGS_ROW_CLASS)
      rowHost.style.removeProperty('display')
      rowHost.style.removeProperty('align-items')
      rowHost.style.removeProperty('gap')
      rowHost.style.removeProperty('width')
    }
    if (patchedTrigger) {
      patchedTrigger.style.removeProperty('flex')
      patchedTrigger.style.removeProperty('width')
      patchedTrigger.style.removeProperty('min-width')
    }
    rowHost = undefined
    patchedTrigger = undefined
    patchedRail = undefined
    if (timer !== undefined)
      clearInterval(timer)
  }
}
