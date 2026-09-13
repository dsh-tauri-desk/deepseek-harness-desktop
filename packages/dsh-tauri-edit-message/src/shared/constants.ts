/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * 路由刻意沿用上游 `message-tree` 拼写：Moeblack 的 dsh-message-edit 已占用
 * `/message-edit`，同时安装会冲突。
 */

/** 插件名（诊断元数据 / 依赖声明）。 */
export const EDIT_MESSAGE_PLUGIN_NAME = 'dsh-tauri-edit-message'

/** 同源接口路径：POST 建一条截断后的新会话（客户端随后发送改后的文本）。 */
export const MESSAGE_TREE_PATH = '/message-tree'
