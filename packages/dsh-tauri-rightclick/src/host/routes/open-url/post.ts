import { defineEventHandler, readBody, safeWebUrl } from 'dsh-tauri'
import { get } from 'lodash-es'
import { JSON_CONTENT_TYPE } from '../../config/constants'
import { opener } from '../../service/opener'

export default defineEventHandler(async (event) => {
  const contentType = event.req.headers.get('content-type') ?? ''
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    event.res.status = 415
    return { ok: false as const, error: 'unsupported-media-type' }
  }

  const body = await readBody<{ url?: unknown }>(event, { type: 'json' })
  const url = safeWebUrl(get(body, 'url'))
  if (!url) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-url' }
  }

  const result = await opener.openUrl(url)
  if (!result.ok)
    event.res.status = 500
  return result
})
