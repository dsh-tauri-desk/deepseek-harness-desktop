import { defineRoutes } from 'dsh-tauri'
import { OPEN_PATH_ROUTE, OPEN_URL_ROUTE } from '../../shared/constants'
import openPath from './open-path/post'
import openUrl from './open-url/post'

export const routes = defineRoutes((disposer) => {
  disposer.post({ kind: 'exact', path: OPEN_URL_ROUTE }, openUrl)
  disposer.post({ kind: 'exact', path: OPEN_PATH_ROUTE }, openPath)
})
