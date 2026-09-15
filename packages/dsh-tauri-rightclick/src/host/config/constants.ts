import { RIGHTCLICK_PLUGIN_NAME } from '../../shared/constants'

export const ROUTES_EFFECT = `${RIGHTCLICK_PLUGIN_NAME}: routes`
export const HOST_RUNTIME_EFFECT = `${RIGHTCLICK_PLUGIN_NAME}: host runtime`

/** 只接受同源 JSON POST：readBody 会忽略 Content-Type，这道闸缺了就会放行 text/plain。 */
export const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i

/** 带 URL scheme 的值不是本地路径（外链走 open-url）。 */
export const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i
