import { defineEventHandler, readBody } from 'dsh-tauri'
import { isEmpty, isString, trim } from 'lodash-es'
import { JSON_CONTENT_TYPE, URL_SCHEME_PATTERN } from '../../config/constants'
import { opener } from '../../service/opener'

export default defineEventHandler(async (event) => {
  const contentType = event.req.headers.get('content-type') ?? ''
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    event.res.status = 415
    return { ok: false as const, error: 'unsupported-media-type' }
  }

  const body = await readBody<{ path?: unknown }>(event, { type: 'json' })
  const raw = body?.path
  const path = isString(raw) ? trim(raw) : ''
  if (isEmpty(path) || URL_SCHEME_PATTERN.test(path)) {
    event.res.status = 400
    return { ok: false as const, error: 'invalid-path' }
  }

  const result = await opener.openDirectory(path)
  if (!result.ok)
    event.res.status = 400
  return result
})
