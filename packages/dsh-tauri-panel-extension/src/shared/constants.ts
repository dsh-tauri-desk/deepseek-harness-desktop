/**
 * shared/constants.ts — 跨 host/client 的稳定协议常量（panel-extension）。
 * Adapted from qinyre/dsh-plugin-capabilities. Copyright (c) 2026 qinyre.
 * Licensed under the MIT License.
 */

/** 稳定 host/plugin 标识。 */
export const PLUGIN_NAME = 'dsh-tauri-panel-extension'

/** HTTP 命名空间暴露给客户端半区。 */
export const API_PREFIX = `/${PLUGIN_NAME}`
