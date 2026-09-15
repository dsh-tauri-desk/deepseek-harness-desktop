import type { ArchiveSort, ArchiveState } from './archive.types'
import { defineStore } from 'dsh-tauri/client'

export const archive = defineStore({
  state: (): ArchiveState => ({
    archived: { archivedSessionIds: [], meta: {} },
    sort: 'updatedAt',
    query: '',
    workspaceId: 'all',
    loading: false,
    pending: false,
    error: '',
    suppressedSessionIds: [],
    titleById: {},
    refreshGeneration: 0,
  }),
  actions: {
    setSort(sort: ArchiveSort) {
      this.sort = sort
    },
    setQuery(query: string) {
      this.query = query
    },
    setWorkspaceFilter(workspaceId: string) {
      this.workspaceId = workspaceId
    },
    /** 推进刷新代数并返回本次代际（service 的并发保护凭据）。 */
    beginRefresh(): number {
      this.refreshGeneration += 1
      return this.refreshGeneration
    },
    isCurrentRefresh(generation: number): boolean {
      return generation === this.refreshGeneration
    },
    /** 合并观测到的行标题（值比较后写入，避免无谓重渲染）。 */
    mergeTitles(titles: Record<string, string>) {
      if (Object.entries(titles).every(([id, title]) => this.titleById[id] === title))
        return
      this.titleById = { ...this.titleById, ...titles }
    },
  },
})
