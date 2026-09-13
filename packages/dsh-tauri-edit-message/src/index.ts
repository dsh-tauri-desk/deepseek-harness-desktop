/**
 * index.ts — 宿主半区公开面（loader 从 package.json 的 main 加载本文件）。
 */

export { apply, inject } from './host/apply'
export { EDIT_MESSAGE_PLUGIN_NAME, MESSAGE_TREE_PATH } from './shared/constants'
