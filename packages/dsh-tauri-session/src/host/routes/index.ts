import { defineRoutes } from 'dsh-tauri'
import { SESSION_API_PREFIX } from '../../shared/constants'
import clearSessionArchive from './session/archive/clear/post'
import deleteSessionArchive from './session/archive/delete'
import getSessionArchive from './session/archive/get'
import postSessionArchive from './session/archive/post'
import postSessionOpenPath from './session/open-path/post'
import postSessionUnarchive from './session/unarchive/post'
import deleteSessionWorkspaceArchive from './session/workspace/archive/delete'
import postSessionWorkspaceArchive from './session/workspace/archive/post'

const SESSION_ARCHIVE = `${SESSION_API_PREFIX}/session/archive`
const SESSION_WORKSPACE_ARCHIVE = `${SESSION_API_PREFIX}/session/workspace/archive`

/**
 * 归档资源路由声明（文件路径 = URL 路径）。
 * 同一路径只允许声明一次（宿主按 (kind, path) 收敛为一行注册），方法分发交给 h3。
 */
export const routes = defineRoutes((disposer) => {
  disposer.get({ kind: 'exact', path: SESSION_ARCHIVE }, getSessionArchive)
  disposer.post({ kind: 'exact', path: SESSION_ARCHIVE }, postSessionArchive)
  disposer.delete({ kind: 'exact', path: SESSION_ARCHIVE }, deleteSessionArchive)

  disposer.post({ kind: 'exact', path: `${SESSION_ARCHIVE}/clear` }, clearSessionArchive)
  disposer.delete({ kind: 'exact', path: `${SESSION_ARCHIVE}/clear` }, clearSessionArchive)

  disposer.post({ kind: 'exact', path: SESSION_WORKSPACE_ARCHIVE }, postSessionWorkspaceArchive)
  disposer.delete({ kind: 'exact', path: SESSION_WORKSPACE_ARCHIVE }, deleteSessionWorkspaceArchive)

  disposer.post({ kind: 'exact', path: `${SESSION_API_PREFIX}/session/unarchive` }, postSessionUnarchive)
  disposer.post({ kind: 'exact', path: `${SESSION_API_PREFIX}/session/open-path` }, postSessionOpenPath)
})
