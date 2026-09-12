/** Bilingual copy for the pet settings section. */
import type { ClientContext } from 'dsh-tauri/client'
import type { LocaleKey } from '../types'
import { createExternalStore } from 'dsh-tauri/client'
import { useSyncExternalStore } from 'react'
import { PET_CLIENT_NS as NS } from '../constants'

export { PET_CLIENT_NS as NS } from '../constants'

const DICT_ZH: Record<LocaleKey, string> = {
  clear: '取消选择',
  clearFailed: '取消选择失败',
  closePet: '关闭宠物',
  create: '创建',
  createFailed: '创建宠物会话失败',
  emptyImported: '尚未导入宠物，点击右上角「导入」添加 .zip 资源包',
  enable: '启用',
  enablePet: '启用宠物',
  import: '导入',
  importFailed: '导入宠物失败',
  listFailed: '读取宠物列表失败',
  loading: '加载中…',
  name: '宠物',
  select: '选择',
  setPetFailed: '选择宠物失败',
  setSizeFailed: '设置宠物大小失败',
  sizeHint: '调整桌宠窗口的显示大小（50–200%）',
  sizeLabel: '大小',
  tabCodexDesc: '从 Codex 或压缩包中导入 Codex 宠物（支持 .zip 文件）',
  tabInstalledDesc: '宠物会管理对话串，并突出显示需要关注的事项',
  toggleFailed: '切换桌宠开关失败',
}

const DICT_EN: Record<LocaleKey, string> = {
  clear: 'Clear selection',
  clearFailed: 'Failed to clear pet selection',
  closePet: 'Close pet',
  create: 'Create',
  createFailed: 'Failed to create a pet session',
  emptyImported: 'No pets imported yet. Click “Import” to add a .zip package',
  enable: 'Enable',
  enablePet: 'Enable pet',
  import: 'Import',
  importFailed: 'Failed to import pet',
  listFailed: 'Failed to load pet list',
  loading: 'Loading…',
  name: 'Pets',
  select: 'Choose',
  setPetFailed: 'Failed to select pet',
  setSizeFailed: 'Failed to set pet size',
  sizeHint: 'Adjust the pet window size (50–200%)',
  sizeLabel: 'Size',
  tabCodexDesc: 'Import Codex pets from Codex or archives (.zip files supported)',
  tabInstalledDesc: 'Pets manage your conversation threads and highlight items that need attention',
  toggleFailed: 'Failed to toggle the pet',
}

let activeLocale = 'en'
const localeRevision = createExternalStore({ revision: 0 })

export function registerLocale(ctx: ClientContext): void {
  activeLocale = ctx.locale.getLocale().active
  ctx.locale.register(NS, 'zh', DICT_ZH)
  ctx.locale.register(NS, 'en', DICT_EN)
  ctx.locale.subscribe(() => {
    try {
      activeLocale = ctx.locale.getLocale().active
    }
    catch {
      // 插件 reload/卸载时上下文会短暂失效（inactive context），服务访问器抛错；
      // 此时无需更新本地 locale 快照，忽略本次通知避免 `locale subscriber crashed` 刷屏。
      return
    }
    localeRevision.set(state => ({ revision: state.revision + 1 }))
  })
}

export function usePetLocale(): void {
  useSyncExternalStore(localeRevision.subscribe, () => localeRevision.getSnapshot().revision)
}

export function text(key: LocaleKey): string {
  const dict = activeLocale.toLowerCase().startsWith('en') ? DICT_EN : DICT_ZH
  return dict[key] ?? DICT_EN[key] ?? key
}
