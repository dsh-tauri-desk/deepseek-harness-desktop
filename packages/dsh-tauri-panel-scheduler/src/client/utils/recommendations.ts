import type { ScheduleForm, TaskView, Translate } from '../types'

export interface RecommendationMatch {
  id: string
  nameKey: string
  promptKey: string
  schedule: ScheduleForm
}

function sameSchedule(left: TaskView['schedule'], right: ScheduleForm): boolean {
  if (left.kind !== right.kind)
    return false
  if (left.kind === 'interval' && right.kind === 'interval')
    return left.everyMinutes === right.everyMinutes
  if (left.kind === 'weekly' && right.kind === 'weekly')
    return left.time === right.time && left.weekdays.length === right.weekdays.length && left.weekdays.every(day => right.weekdays.includes(day))
  if ((left.kind === 'daily' || left.kind === 'workdays') && (right.kind === 'daily' || right.kind === 'workdays'))
    return left.time === right.time
  return false
}

/** 判断任务是否由该推荐创建，兼容 recommendationId 引入前的旧任务。 */
export function recommendationMatchesTask(rec: RecommendationMatch, task: TaskView, t: Translate): boolean {
  return task.recommendationId === rec.id
    || (task.recommendationId === undefined
      && task.name === t(rec.nameKey)
      && task.prompt === t(rec.promptKey)
      && sameSchedule(task.schedule, rec.schedule))
}
