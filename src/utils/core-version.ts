/**
 * 核心(dsh)版本判断：以 rc.2 为硬编码基准，高于该基准的版本引入破坏性更改、
 * 可能影响第三方插件。该判断与「推荐版本」逻辑无关，仅作为用户提示的阈值。
 */
export const CORE_BREAKING_BASELINE = '0.1.1-rc.2'

/**
 * 简化 semver 比较（不引入额外依赖），可处理 `0.1.1-rc.2` / `0.1.1` 以及
 * release tag（`dsh-`/`src-` 前缀、末尾 `-<commit>` 后缀）。
 * 返回值：负数 a < b，0 相等，正数 a > b。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    let v = value
    while (v.startsWith('dsh-') || v.startsWith('src-'))
      v = v.replace(/^(?:src|dsh)-/, '')
    if (v.includes('-')) {
      const candidate = v.slice(0, v.lastIndexOf('-'))
      if (/^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?$/i.test(candidate))
        v = candidate
    }
    const [core, pre = ''] = v.split('-', 2)
    const nums = core.split('.').map(n => parseInt(n, 10) || 0)
    return { nums, pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y)
      return x < y ? -1 : 1
  }
  // 无预发布号 > 有预发布号
  if (!pa.pre && !pb.pre)
    return 0
  if (!pa.pre)
    return 1
  if (!pb.pre)
    return -1
  // 预发布号按点分段比较：数字按数值、非数字按字典序
  const paParts = pa.pre.split('.').map(p => (Number.isNaN(Number(p)) ? p : Number(p)))
  const pbParts = pb.pre.split('.').map(p => (Number.isNaN(Number(p)) ? p : Number(p)))
  const len = Math.max(paParts.length, pbParts.length)
  for (let i = 0; i < len; i++) {
    const x = paParts[i]
    const y = pbParts[i]
    if (x === undefined)
      return -1
    if (y === undefined)
      return 1
    if (x === y)
      continue
    if (typeof x === 'number' && typeof y === 'number')
      return x < y ? -1 : 1
    if (typeof x === 'number')
      return -1
    if (typeof y === 'number')
      return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 判断核心版本（版本串或 release tag）是否高于 rc.2 基准（引入破坏性更改） */
export function isCoreBreakingVersion(version: string): boolean {
  return !!version && compareVersions(version, CORE_BREAKING_BASELINE) > 0
}
