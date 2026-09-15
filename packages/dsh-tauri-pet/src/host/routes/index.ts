import { defineRoutes } from 'dsh-tauri'
import { SESSION_STREAM_PATH } from '../../shared/constants'
import sessionStream from './session-stream/get'

export const routes = defineRoutes((disposer) => {
  disposer.get({ kind: 'exact', path: SESSION_STREAM_PATH }, sessionStream)
})
