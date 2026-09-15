import type { ExtensionRouteDeps } from '../index.types'
import { defineEventHandler, dshRouteDepsOf } from 'dsh-tauri'
import { mcp } from '../../service/mcp'

export default defineEventHandler((event) => {
  const deps = dshRouteDepsOf<ExtensionRouteDeps>(event)!
  return { ...mcp.list(deps.profileDirPath), restartNeeded: true }
})
