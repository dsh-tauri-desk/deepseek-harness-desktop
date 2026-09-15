/**
 * shared/constants.ts — dsh-tauri-pet 宿主/客户端共享的协议常量。
 *
 * SSE 流路径与 Rust 消费端（`src-tauri/src/bridge/pet.rs` 的 `SESSION_STREAM_PATH`）
 * 逐字一致：改这里等于改协议，必须两侧同步。
 */

/** 插件名（诊断元数据、locale 命名空间与注册标识）。 */
export const PET_PLUGIN_NAME = 'dsh-tauri-pet'

/** 桌宠会话增量 SSE 流路径（Rust 按 `http://127.0.0.1:<DSH_WEB_PORT>` + 此路径订阅）。 */
export const SESSION_STREAM_PATH = '/api/dsh-pet/session-stream'

/** SSE 重连间隔提示（毫秒）。 */
export const SSE_RETRY_MS = 1000

/** SSE 心跳注释帧间隔（毫秒）：防止代理/空闲断连。 */
export const SSE_KEEPALIVE_MS = 15_000

/** 心跳注释帧文本（`stream.pushComment` 渲染为 `: keepalive\n\n`）。 */
export const SSE_KEEPALIVE_COMMENT = 'keepalive'
