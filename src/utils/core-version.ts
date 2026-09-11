import semver from 'semver'

/**
 * 核心(dsh)版本判断：以 rc.2 为硬编码基准，高于该基准的版本引入破坏性更改、
 * 可能影响第三方插件。该判断与「推荐版本」逻辑无关，仅作为用户提示的阈值。
 */
export const CORE_BREAKING_BASELINE = '0.1.2-rc.1'

/**
 * Semver comparison using the `semver` package.
 * Handles `dsh-`/`src-` prefixes (including repeated `dsh-src-` chains) by
 * stripping before comparison; unparsable values compare as equal.
 * Returns: negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const clean = (v: string) => {
    let s = v
    while (s.startsWith('dsh-') || s.startsWith('src-'))
      s = s.replace(/^(?:src|dsh)-/, '')
    return s
  }
  const pa = semver.parse(clean(a))
  const pb = semver.parse(clean(b))
  if (!pa || !pb)
    return 0
  return semver.compare(pa, pb)
}

/** 判断核心版本（版本串或 release tag）是否高于 rc.2 基准（引入破坏性更改） */
export function isCoreBreakingVersion(version: string): boolean {
  return !!version && compareVersions(version, CORE_BREAKING_BASELINE) > 0
}
