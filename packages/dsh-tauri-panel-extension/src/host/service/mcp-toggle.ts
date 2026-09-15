import { defineService } from 'dsh-tauri'
import { loadPatch, managedInsert, mcpRowItems, savePatch } from './mcp.utils'

export const mcpToggle = defineService({
  save(dirPath: string, id: string, disabled: boolean): boolean {
    const doc = loadPatch(dirPath)
    managedInsert(doc)
    const hit = mcpRowItems(doc).find(({ node }) => String(node.get('id') ?? '') === id)
    if (hit === undefined)
      return false
    if (disabled)
      hit.node.set('disabled', true)
    else
      hit.node.delete('disabled')
    savePatch(dirPath, doc)
    return true
  },
})
