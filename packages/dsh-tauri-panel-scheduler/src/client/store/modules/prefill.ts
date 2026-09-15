import type { PrefillState } from './prefill.types'
import { defineStore } from 'dsh-tauri/client'

export const prefill = defineStore({
  state: (): PrefillState => ({ pending: '' }),
  actions: {
    set(text: string) {
      this.pending = text
    },
    clear() {
      this.pending = ''
    },
  },
})
