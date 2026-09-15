import { defineRoutes } from 'dsh-tauri'
import { SCHEDULER_API_PREFIX } from '../../shared/constants'
import historyDelete from './history/delete/post'
import history from './history/get'
import options from './options/get'
import recover from './recover/post'
import tasksCreate from './tasks/create/post'
import tasksDelete from './tasks/delete/post'
import tasks from './tasks/get'
import tasksRun from './tasks/run/post'
import tasksToggle from './tasks/toggle/post'
import tasksUpdate from './tasks/update/post'

export const routes = defineRoutes((disposer) => {
  disposer.get({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks` }, tasks)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks/create` }, tasksCreate)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks/update` }, tasksUpdate)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks/toggle` }, tasksToggle)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks/delete` }, tasksDelete)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/tasks/run` }, tasksRun)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/history/delete` }, historyDelete)
  disposer.get({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/history` }, history)
  disposer.get({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/options` }, options)
  disposer.post({ kind: 'exact', path: `${SCHEDULER_API_PREFIX}/recover` }, recover)
})
