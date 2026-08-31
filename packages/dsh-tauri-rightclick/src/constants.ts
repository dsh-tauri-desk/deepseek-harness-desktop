/** Host-half protocol constants for dsh-tauri-rightclick. */

export const RIGHTCLICK_PLUGIN_NAME = 'dsh-tauri-rightclick'
export const RIGHTCLICK_API_PREFIX = '/api/dsh-rightclick-menu'
/** 用系统默认浏览器打开外链（POST，同源 JSON）。 */
export const OPEN_URL_ROUTE = `${RIGHTCLICK_API_PREFIX}/open-url`

/** 请求体上限（开链只传一个小 JSON）。 */
export const MAX_BODY_BYTES = 64 * 1024
