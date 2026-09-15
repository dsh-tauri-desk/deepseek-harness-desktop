import type { ExtensionRouteDeps } from './index.types'
import { defineRoutes } from 'dsh-tauri'
import { API_PREFIX } from '../../shared/constants'
import importApply from './import/apply/post'
import importScan from './import/scan/get'
import mcpCheck from './mcp/check/post'
import mcpCopy from './mcp/copy/post'
import mcp from './mcp/get'
import mcpRemove from './mcp/remove/post'
import mcpSave from './mcp/save/post'
import mcpToggle from './mcp/toggle/post'
import open from './open/post'
import restart from './restart/post'
import rootsAdd from './roots/add/post'
import roots from './roots/get'
import rootsRemove from './roots/remove/post'
import skillDelete from './skill/delete/post'
import skill from './skill/get'
import skillPolicy from './skill/policy/post'
import skillSave from './skill/save/post'
import skills from './skills/get'
import skillsRefresh from './skills/refresh/post'

export const routes = defineRoutes<ExtensionRouteDeps>((disposer) => {
  disposer.get({ kind: 'exact', path: `${API_PREFIX}/skills` }, skills)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/skills/refresh` }, skillsRefresh)
  disposer.get({ kind: 'exact', path: `${API_PREFIX}/skill` }, skill)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/skill/save` }, skillSave)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/skill/delete` }, skillDelete)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/skill/policy` }, skillPolicy)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/open` }, open)

  disposer.get({ kind: 'exact', path: `${API_PREFIX}/mcp` }, mcp)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/mcp/save` }, mcpSave)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/mcp/toggle` }, mcpToggle)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/mcp/remove` }, mcpRemove)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/mcp/check` }, mcpCheck)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/mcp/copy` }, mcpCopy)

  disposer.get({ kind: 'exact', path: `${API_PREFIX}/import/scan` }, importScan)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/import/apply` }, importApply)

  disposer.get({ kind: 'exact', path: `${API_PREFIX}/roots` }, roots)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/roots/add` }, rootsAdd)
  disposer.post({ kind: 'exact', path: `${API_PREFIX}/roots/remove` }, rootsRemove)

  disposer.post({ kind: 'exact', path: `${API_PREFIX}/restart` }, restart)
})
