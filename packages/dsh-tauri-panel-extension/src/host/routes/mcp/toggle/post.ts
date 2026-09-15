import type { ExtensionRouteDeps } from '../../index.types'
import { defineEventHandler, dshRouteDepsOf, readBody } from 'dsh-tauri'
import { mcpToggle } from '../../../service/mcp-toggle'
import { mcpScopeDir, normalizeMcpScope } from '../../../service/mcp.utils'

interface McpToggleBody { id?: unknown, disabled?: unknown, scope?: unknown }

export default defineEventHandler(async (event) => {
  const deps = dshRouteDepsOf<ExtensionRouteDeps>(event)!
  const body = await readBody<McpToggleBody>(event, { type: 'json' })
  if (typeof body?.id !== 'string' || typeof body.disabled !== 'boolean') {
    event.res.status = 400
    return { error: 'id and disabled are required' }
  }
  const id = body.id
  const disabled = body.disabled
  try {
    const ok = mcpToggle.save(mcpScopeDir(normalizeMcpScope(body.scope), deps.profileDirPath), id, disabled)
    if (!ok) {
      event.res.status = 404
      return { error: 'server row not found' }
    }
    return { ok: true, restartNeeded: true }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
