/** 一次工作区容量治理的结果。 */
export interface RetentionOutcome {
  /** 是否执行了不可达对象回收。 */
  pruned: boolean
  /** 治理后测得的私有仓体积（MB）。 */
  repoSizeMb: number
  /** 是否因超限做了整仓隔离重建（此后旧 turn 全部转为过期）。 */
  rebuilt: boolean
  /** 复检后的排除清单。 */
  exclusions: string[]
}
