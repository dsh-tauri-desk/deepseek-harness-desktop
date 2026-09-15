import type * as Types from './index.type'
import { fetch } from 'dsh-tauri/client'
import { SESSION_API_PREFIX } from '../../shared/constants'

export const baseURL = SESSION_API_PREFIX

const SESSION_ARCHIVE = `${baseURL}/session/archive`
const SESSION_WORKSPACE_ARCHIVE = `${baseURL}/session/workspace/archive`

export function getArchive(): Promise<Types.ArchivedListPayload> {
  return fetch(SESSION_ARCHIVE)
}

export function postArchive(body: Types.PostSessionIdBody): Promise<Types.ArchivedListPayload> {
  return fetch(SESSION_ARCHIVE, { method: 'POST', body })
}

export function deleteArchive(body: Types.PostSessionIdBody): Promise<Types.ActionResult> {
  return fetch(SESSION_ARCHIVE, { method: 'DELETE', body })
}

export function postArchiveClear(): Promise<Types.ActionResult> {
  return fetch(`${SESSION_ARCHIVE}/clear`, { method: 'POST', body: {} })
}

export function postArchiveWorkspace(body: Types.PostArchiveWorkspaceBody): Promise<Types.ArchivedListPayload> {
  return fetch(SESSION_WORKSPACE_ARCHIVE, { method: 'POST', body })
}

export function deleteArchiveWorkspace(body: Types.PostDeleteWorkspaceBody): Promise<Types.ActionResult> {
  return fetch(SESSION_WORKSPACE_ARCHIVE, { method: 'DELETE', body })
}

export function postUnarchive(body: Types.PostSessionIdBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/session/unarchive`, { method: 'POST', body })
}

export function postOpenSessionDir(body: Types.PostSessionIdBody): Promise<Types.ActionResult> {
  return fetch(`${baseURL}/session/open-path`, { method: 'POST', body })
}
