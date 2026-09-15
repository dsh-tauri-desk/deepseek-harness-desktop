/** 计数组件 props：二进制差异用文案代替行数。 */
export interface ChangeCountsProps {
  insertions: number | null
  deletions: number | null
  binary: boolean
  /** 二进制差异的展示文案（调用方按当前语言提供）。 */
  binaryLabel: string
}
