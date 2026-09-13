/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量。
 *
 * 路由、cordis id 与持久化事件类型刻意沿用上游 `message-tree` 拼写：Moeblack 的
 * dsh-message-edit 已占用 `/message-edit`、cordis id `message-edit` 与事件类型
 * `message-edit/version`，同时安装会冲突；而且已有会话日志里逐字写着
 * `message-tree/version`，改名会让那些版本链接失效。
 */

/** 插件名（诊断元数据 / 依赖声明）。 */
export const EDIT_MESSAGE_PLUGIN_NAME = 'dsh-tauri-edit-message'

/** 同源接口路径：GET 读版本树，POST 建分支 / 取消归档。 */
export const MESSAGE_TREE_PATH = '/message-tree'

/** 持久化版本标记的事件类型（沿用上游）。 */
export const MESSAGE_TREE_EVENT = 'message-tree/version'

/** 持久化版本标记的 schema 版本。 */
export const MESSAGE_TREE_SCHEMA = 1
