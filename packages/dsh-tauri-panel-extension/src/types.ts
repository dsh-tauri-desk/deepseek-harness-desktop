/** Shared types across the capabilities manager modules. */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The webServer service subset this plugin consumes (structural). */
export interface WebServerService {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** DSH Connection's browser trust and authentication boundary. */
export interface ConnectionGate {
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined
}

/** One skill as the host registry reports it (SkillSummary subset). */
export interface HostSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { modelInvocable: boolean, userInvocable: boolean }
  readonly source: string
  readonly provider: string
  /** Provider-specific base (directory skills carry their folder here). */
  readonly resourceBase?: { kind: 'directory', path: string } | { kind: 'url', url: string } | { kind: 'opaque', description: string }
}

/** Loaded skill definition subset the routes consume. */
export interface HostSkillDefinition {
  readonly name: string
  readonly content: string
  readonly path?: string
  readonly resourceBase?: HostSkill['resourceBase']
}

/** The skills service subset this plugin consumes (structural). */
export interface SkillsService {
  list: (options?: { cwd?: string }) => Promise<HostSkill[]>
  get: (name: string, options?: { cwd?: string }) => Promise<HostSkillDefinition | undefined>
}

/** Repository metadata attached to a skill row for client navigation. */
export interface SkillRepositoryMetadata {
  /** Stable repository registration id. */
  id: string
  /** Human-readable local folder or `owner/repo` label. */
  label: string
  kind: 'local' | 'git'
  /** Canonical clickable GitHub URL; present only for GitHub imports. */
  githubUrl?: string
}

/** Host context carrying both services this plugin injects. */
export interface PanelExtensionHost {
  webServer: WebServerService
  skills: SkillsService
  connection: ConnectionGate
}
