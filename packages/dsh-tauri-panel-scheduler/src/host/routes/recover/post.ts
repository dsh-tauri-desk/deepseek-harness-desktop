import { defineEventHandler } from 'dsh-tauri'
import { recovery } from '../../service/recovery'

export default defineEventHandler(async () => {
  await recovery.recover()
  return { ok: true }
})
