/**
 * Foreign-agent config readers: MCP servers from Claude Code (~/.claude.json,
 * ~/.claude/settings.json) and Codex (~/.codex/config.toml). Pure reads of
 * well-known paths; anything missing or malformed yields an empty list.
 */

import type { McpTransport } from './mcp.ts'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

/** One MCP server discovered in a foreign agent's config. */
export interface ImportedServer {
  agent: 'claude-code' | 'codex'
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** Keep only string-valued entries of a record (configs may hold numbers). */
function stringEntries(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string')
      out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const out = value.filter((entry): entry is string => typeof entry === 'string')
  return out.length > 0 ? out : undefined
}

/** Map one Claude mcpServers entry; returns null for unsupported shapes (sse). */
function mapClaudeEntry(name: string, entry: unknown): ImportedServer | null {
  if (typeof entry !== 'object' || entry === null)
    return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : 'stdio'
  if (type === 'stdio' || (type === 'stdio' && record.command !== undefined)) {
    if (typeof record.command !== 'string' || record.command === '')
      return null
    return {
      agent: 'claude-code',
      name,
      transport: 'stdio',
      command: record.command,
      args: stringArray(record.args),
      env: stringEntries(record.env),
    }
  }
  if (type === 'http' || type === 'streamable-http') {
    if (typeof record.url !== 'string' || record.url === '')
      return null
    return {
      agent: 'claude-code',
      name,
      transport: 'streamable-http',
      url: record.url,
      headers: stringEntries(record.headers),
    }
  }
  // 'sse' and anything else: dsh's mcp-client speaks stdio + streamable-http only.
  return null
}

/** MCP servers from Claude Code's user-scope config files. */
export function scanClaudeMcp(home: string = homedir()): ImportedServer[] {
  const merged: Record<string, unknown> = {}
  for (const file of [join(home, '.claude', 'settings.json'), join(home, '.claude.json')]) {
    if (!existsSync(file))
      continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown }
      if (typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null) {
        Object.assign(merged, parsed.mcpServers)
      }
    }
    catch {
      // Broken or partial config: skip the file, keep earlier merges.
    }
  }
  const out: ImportedServer[] = []
  for (const [name, entry] of Object.entries(merged)) {
    const mapped = mapClaudeEntry(name, entry)
    if (mapped !== null)
      out.push(mapped)
  }
  return out
}

/** MCP servers from Codex's config.toml ([mcp_servers.<name>] tables). */
export function scanCodexMcp(home: string = homedir()): ImportedServer[] {
  const file = join(home, '.codex', 'config.toml')
  if (!existsSync(file))
    return []
  let root: Record<string, unknown>
  try {
    root = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  catch {
    return []
  }
  const table = root.mcp_servers
  if (typeof table !== 'object' || table === null)
    return []
  const out: ImportedServer[] = []
  for (const [name, entry] of Object.entries(table)) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const record = entry as Record<string, unknown>
    if (typeof record.command === 'string' && record.command !== '') {
      out.push({
        agent: 'codex',
        name,
        transport: 'stdio',
        command: record.command,
        args: stringArray(record.args),
        env: stringEntries(record.env),
      })
    }
    else if (typeof record.url === 'string' && record.url !== '') {
      out.push({ agent: 'codex', name, transport: 'streamable-http', url: record.url })
    }
  }
  return out
}

/** All foreign-agent MCP servers, deduplicated by (agent, name). */
export function scanAllMcp(home: string = homedir()): ImportedServer[] {
  const seen = new Set<string>()
  return [...scanClaudeMcp(home), ...scanCodexMcp(home)]
    .filter((server) => {
      const key = `${server.agent}/${server.name}`
      if (seen.has(key))
        return false
      seen.add(key)
      return true
    })
}

/** Other agents' skill roots that exist on this machine. */
export function agentSkillRoots(home: string = homedir()): string[] {
  return [join(home, '.claude', 'skills'), join(home, '.codex', 'skills')]
    .filter(path => existsSync(path))
}
