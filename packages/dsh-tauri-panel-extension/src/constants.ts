/**
 * Adapted from qinyre/dsh-plugin-capabilities.
 * Copyright (c) 2026 qinyre. Licensed under the MIT License.
 */

/** Stable host/plugin identifier. */
export const PLUGIN_NAME = 'dsh-tauri-panel-extension'

/** HTTP namespace exposed to the client half. */
export const API_PREFIX = `/${PLUGIN_NAME}`

/** Directory owned by this plugin beneath DSH_HOME. */
export const PLUGIN_STATE_DIRECTORY = PLUGIN_NAME
