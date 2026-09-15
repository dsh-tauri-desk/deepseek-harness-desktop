import type * as Types from './index.type'
import { fetch } from 'dsh-tauri/client'
import { API_PREFIX } from '../../shared/constants'

export const baseURL = API_PREFIX

export function getSkills(): Promise<Types.SkillsResponse> {
  return fetch(`${baseURL}/skills`)
}

export function postSkillsRefresh(): Promise<Types.SkillsResponse> {
  return fetch(`${baseURL}/skills/refresh`, { method: 'POST', body: {} })
}

export function getSkill(name: string): Promise<Types.SkillContentResponse> {
  return fetch(`${baseURL}/skill?name=${encodeURIComponent(name)}`)
}

export function postSkillSave(body: Types.PostSkillSaveBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/skill/save`, { method: 'POST', body })
}

export function postSkillDelete(body: Types.PostSkillDeleteBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/skill/delete`, { method: 'POST', body })
}

export function postSkillPolicy(body: Types.PostSkillPolicyBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/skill/policy`, { method: 'POST', body })
}

export function postOpen(target: { target: 'user-skills' | 'skill', name?: string }): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/open`, { method: 'POST', body: target })
}

export function postRootsAdd(url: string): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/roots/add`, { method: 'POST', body: { kind: 'git', url } })
}

export function getMcp(): Promise<Types.McpListResponse> {
  return fetch(`${baseURL}/mcp`)
}

export function postMcpSave(body: Record<string, unknown>): Promise<Types.McpSaveResponse> {
  return fetch(`${baseURL}/mcp/save`, { method: 'POST', body })
}

export function postMcpCheck(body: { id: string }): Promise<Types.McpConnectivityResponse> {
  return fetch(`${baseURL}/mcp/check`, { method: 'POST', body })
}

export function postMcpToggle(body: Types.PostMcpToggleBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/mcp/toggle`, { method: 'POST', body })
}

export function postMcpRemove(body: Types.PostMcpRemoveBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/mcp/remove`, { method: 'POST', body })
}

export function getMcpImportScan(): Promise<Types.McpImportScanResponse> {
  return fetch(`${baseURL}/import/scan`)
}

export function postMcpImportApply(body: Types.PostMcpApplyImportBody): Promise<Types.McpApplyImportResponse> {
  return fetch(`${baseURL}/import/apply`, { method: 'POST', body })
}

export function postRestart(): Promise<unknown> {
  return fetch(`${baseURL}/restart`, { method: 'POST', body: {} })
}
