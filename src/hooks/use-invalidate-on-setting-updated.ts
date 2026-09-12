import type { QueryKey } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useListen } from '@/hooks/use-listen'

/**
 * 订阅后端 `setting_updated` 事件并失效指定查询。
 *
 * cores / profiles / plugins / backups 四个查询都要「后端设置一变就重拉」，
 * 此前各自写一份 `useListen('setting_updated', () => invalidateQueries(...))`；
 * 收敛到这里，事件名与失效语义只有一个出处。
 *
 * `queryKey` 每次渲染传新数组即可（`useListen` 只在事件名变化时重订阅）。
 */
export function useInvalidateOnSettingUpdated(queryKey: QueryKey): void {
  const queryClient = useQueryClient()

  useListen('setting_updated', () => {
    void queryClient.invalidateQueries({ queryKey })
  })
}
