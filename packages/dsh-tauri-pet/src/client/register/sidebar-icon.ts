import type { RegisterController } from 'dsh-tauri/client'
import { defineRegister } from 'dsh-tauri/client'
import {
  PET_ICON_RETRY_MAX,
  PET_ICON_RETRY_MS,
  SETTINGS_TRIGGER_SELECTOR,
  SIDEBAR_SELECTOR,
} from '../constants'
import { locale } from '../locales'
import { loadPetStatus, togglePet } from '../service/pet'
import { store } from '../store'
import {
  applySettingsRow,
  createIconButton,
  isRailTrigger,
  revertSettingsRow,
  syncIconState,
} from './sidebar-icon.utils'

/**
 * register/sidebar-icon.ts — 侧栏「桌宠入口」DOM 补丁。
 *
 * 入口是 `.sidebar.settings` 容器（dsh-tauri-ui 的设置触发器所在处）的子元素：紧贴
 * `.dshp-settings-trigger` 右侧的原生按钮，样式复刻官方 iconButton。按钮两态（绿点 =
 * 已启用），点击即切换启用状态，不弹面板（设置走 settings.section 页）。
 *
 * 挂载策略：MutationObserver 监听 document.body，侧栏就绪后插入并持续看护（React
 * 重渲染容器后自动补插）；guard 属性 + 位置校验防止重复插入与死循环。观察器、重试
 * 计时器、订阅、事件与收尾全部登记进控制器，卸载即释放。
 */
export const sidebarIconFeature = defineRegister((controller) => {
  registerSidebarPetIcon(controller)
})

// --- internal ---

/** 当前是否启用（绿点两态的唯一真值来自共享 store）。 */
function iconActive(): boolean {
  return store.pet.$state.status?.enabled ?? false
}

/**
 * 切换桌宠启用状态（失败由服务层记录，设置页内有完整错误展示）。
 *
 * 纯持久开关：关掉就落盘 `enabled=false`，重启后不会自己再起来。用户点这个按钮的语义
 * 是「关掉宠物」，不是「这次先收起来」。
 */
async function toggleEnabled(): Promise<void> {
  await togglePet({ enabled: !iconActive() })
}

function registerSidebarPetIcon(controller: RegisterController): void {
  if (typeof document === 'undefined')
    return

  const button = createIconButton(locale.text('name'))
  /** 当前打过设置行类的宿主（卸载时移除，React 重渲染换宿主时随旧节点废弃）。 */
  let rowHost: HTMLElement | undefined
  /** 上一次做过内联宽度修正的触发器（折叠态/卸载时撤销）。 */
  let patchedTrigger: HTMLElement | undefined
  /** 上次修正时触发器是否为折叠态（Rail），状态翻转时需重写内联样式。 */
  let patchedRail: boolean | undefined

  const onClick = (): void => {
    void toggleEnabled()
  }
  button.addEventListener('click', onClick)
  controller.add(() => button.removeEventListener('click', onClick))

  // 状态缓存订阅：绿点两态随 store 变化；首屏再拉取一次权威状态。
  controller.add(store.pet.$subscribe(() => syncIconState(button, iconActive())))
  void loadPetStatus()
  syncIconState(button, iconActive())

  /** 行布局只在宿主/触发器/折叠态真的变化时才重写（观察器回调高频）。 */
  function applyRowStyles(host: HTMLElement, trigger: HTMLElement): void {
    const rail = isRailTrigger(trigger)
    if (host === rowHost && trigger === patchedTrigger && rail === patchedRail)
      return
    applySettingsRow(host, trigger, rail)
    rowHost = host
    patchedTrigger = trigger
    patchedRail = rail
  }

  /** 看护入口按钮：触发器就绪且按钮不在其右侧时（首次挂载 / React 重渲染丢弃）重新插入。 */
  function ensurePlaced(): void {
    const trigger = document.querySelector<HTMLElement>(SETTINGS_TRIGGER_SELECTOR)
    if (!trigger?.parentElement)
      return
    applyRowStyles(trigger.parentElement, trigger)
    if (button.isConnected && button.previousElementSibling === trigger)
      return
    trigger.after(button)
    syncIconState(button, iconActive())
  }

  function scan(): void {
    // 侧栏未就绪时静默跳过（由重试计时器兜底），就绪后交由观察器看护。
    if (!document.querySelector(SIDEBAR_SELECTOR))
      return
    ensurePlaced()
  }

  controller.observe(document.body, scan, { childList: true, subtree: true })

  // 观察器已覆盖侧栏子树，这里再保留一条短暂轮询兜底（侧栏出现即停、最多
  // PET_ICON_RETRY_MAX 次）：应用晚挂载时可能长时间没有任何 DOM 变更。
  let tries = 0
  const stopPolling = controller.interval(() => {
    scan()
    if (document.querySelector(SIDEBAR_SELECTOR) || ++tries > PET_ICON_RETRY_MAX)
      stopPolling()
  }, PET_ICON_RETRY_MS)
  // 首轮立即尝试（侧栏可能已就绪）。
  scan()

  // 收尾：注册顺序保证它在观察器断开之后执行（否则移除按钮会触发 scan 重新插入）。
  controller.add(() => {
    button.remove()
    revertSettingsRow(rowHost, patchedTrigger)
    rowHost = undefined
    patchedTrigger = undefined
    patchedRail = undefined
  })
}
