import type { McpInput } from '../../../service/mcp.types'
import type { ExtensionRouteDeps } from '../../index.types'
import { defineEventHandler, dshRouteDepsOf, readBody } from 'dsh-tauri'
import { mcp } from '../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope, validateMcpInput } from '../../../service/mcp.utils'

export default defineEventHandler(async (event) => {
  const deps = dshRouteDepsOf<ExtensionRouteDeps>(event)!
  const body = await readBody<McpInput & { scope?: unknown }>(event, { type: 'json' })
  if (body === undefined) {
    event.res.status = 400
    return { error: 'invalid-body' }
  }
  try {
    const invalid = validateMcpInput(body)
    if (invalid !== null) {
      event.res.status = 400
      return { error: invalid }
    }
    const scope = normalizeMcpScope(body.scope)
    const id = mcp.save(mcpScopeDir(scope, deps.profileDirPath), body)
    return { ok: true, id, restartNeeded: true }
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
