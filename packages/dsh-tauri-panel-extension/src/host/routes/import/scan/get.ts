import type { ExtensionRouteDeps } from '../../index.types'
import { defineEventHandler, dshRouteDepsOf } from 'dsh-tauri'
import { agents } from '../../../service/agents'
import { mcp } from '../../../service/mcp'

export default defineEventHandler((event) => {
  const deps = dshRouteDepsOf<ExtensionRouteDeps>(event)!
  try {
    return {
      servers: agents.resolve(),
      existing: mcp.list(deps.profileDirPath).servers.map(row => row.serverName),
    }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
