import type { RunView, SchedulerOptions, TaskInput, TaskView } from '../types'

export type { RunView, SchedulerOptions, TaskView }

/** GET /tasks 响应。 */
export interface TasksResponse {
  tasks: TaskView[]
}

/** GET /history 响应。 */
export interface RunsResponse {
  runs: RunView[]
}

/** 任务变更结果（create/update/toggle 携带最新任务视图）。 */
export interface TaskActionResult {
  ok: boolean
  task?: TaskView
  error?: string
}

/** 简单动作结果（delete/run/history delete）。 */
export interface SimpleActionResult {
  ok: boolean
  error?: string
}

/** GET /tasks 查询参数。 */
export interface GetTasksQuery {
  search?: string
}

/** GET /history 查询参数。 */
export interface GetHistoryQuery {
  taskId?: string
}

/** POST /tasks/create 请求体（宿主任务表单字段平铺）。 */
export type PostTasksCreateBody = TaskInput

/** POST /tasks/update 请求体（id 不可被 input 覆盖）。 */
export interface PostTasksUpdateBody {
  id: string
  input: TaskInput
}

/** POST /tasks/toggle 请求体。 */
export interface PostTasksToggleBody {
  id: string
  enabled: boolean
}

/** POST /tasks/delete、/tasks/run、/history/delete 请求体。 */
export interface PostIdBody {
  id: string
}
