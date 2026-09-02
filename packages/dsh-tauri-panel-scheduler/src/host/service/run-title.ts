/**
 * host/service/run-title.ts — 定时执行 Session 的展示标题。
 *  对齐 MichengAI/dsh-automation 的 src/run-title.ts。
 */

export function formatRunStamp(iso: string): string {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime()))
    return iso
  const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const time = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
  return `${date} ${time}`
}

export function schedulerSessionTitle(taskName: string, iso: string): string {
  return `${formatRunStamp(iso)} - ${taskName}`
}
