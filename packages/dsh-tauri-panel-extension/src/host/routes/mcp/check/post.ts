import type { ExtensionRouteDeps } from '../../index.types'
import { defineEventHandler, dshRouteDepsOf, readBody } from 'dsh-tauri'
import { mcp } from '../../../service/mcp'
import { mcpScopeDir, normalizeMcpScope } from '../../../service/mcp.utils'

interface McpCheckBody { id?: unknown, scope?: unknown }

export default defineEventHandler(async (event) => {
  const deps = dshRouteDepsOf<ExtensionRouteDeps>(event)!
  const body = await readBody<McpCheckBody>(event, { type: 'json' })
  if (typeof body?.id !== 'string') {
    event.res.status = 400
    return { error: 'id is required' }
  }
  const id = body.id
  try {
    const dir = mcpScopeDir(normalizeMcpScope(body.scope), deps.profileDirPath)
    const row = mcp.peek(dir).find(item => item.id === id)
    if (row === undefined) {
      event.res.status = 404
      return { error: 'server row not found' }
    }
    return await mcp.check(row)
  }
  catch (error) {
    event.res.status = 500
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
