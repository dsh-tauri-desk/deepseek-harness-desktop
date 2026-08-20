import { desktopUpdate } from './modules/desktop-update'
import { download } from './modules/download'
import { harness } from './modules/harness'
import { setting } from './modules/setting'
import { updater } from './modules/updater'

/** 全局 store 聚合（参考 damn-reports 的组织方式：模块各自独立，聚合统一出口） */
export const store = {
  harness,
  updater,
  download,
  setting,
  desktopUpdate,
}

export { desktopUpdate } from './modules/desktop-update'
export type {
  DesktopAboutInfo,
  DesktopDownloadProgress,
  DesktopUpdateInfo,
} from './modules/desktop-update'
export { download } from './modules/download'
export type { DownloadFinishedPayload } from './modules/download'
export { harness } from './modules/harness'
export type {
  InstallerState,
  InstallProgress,
  PluginCommandLogPayload,
  PreinstallPlugin,
  SetupStatus,
  SidebarBusyAction,
} from './modules/harness'
export { setting } from './modules/setting'
export { updater } from './modules/updater'
export type { DshUpdateInfo } from './modules/updater'
