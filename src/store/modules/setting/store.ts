import { listen } from '@tauri-apps/api/event'
import { defineStore } from 'valtio-define'
import { persist } from 'valtio-define/plugins/persist'
import { storage } from '@/config/storage'

export const setting = defineStore({
  state: () => ({
    installed: false,
    port: 3080,
    auto_start: true,
    cli_link_enabled: true,
    zoom_factor: 1,
    close_action: 'tray',
    backup_retention_count: 10,
    backup_include_credentials: false,
    language: null as string | null,
  }),
  persist: {
    key: 'setting',
    storage,
  },
})

setting.use(persist({ hydrate: false }))

const unlisten = listen<typeof setting.$state>('setting_updated', async (event) => {
  setting.$patch(event.payload)
  await setting.$persist.rehydrate()
  unlisten.then(unlisten => unlisten())
})
