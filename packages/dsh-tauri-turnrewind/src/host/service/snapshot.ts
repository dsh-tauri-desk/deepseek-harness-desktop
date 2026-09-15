/**
 * host/service/snapshot.ts — 每个工作区一个**私有 Git 快照仓**的捕获 / 差异 / 恢复引擎。
 *
 * 设计要点：
 *   - 私有仓自包含（不借源仓库对象、不用 alternates），源仓库 gc 不会破坏快照；
 *   - 私有仓自带 index（stat 缓存让 `add --all` 后续轮次天然增量）；
 *   - 源仓库只做只读探测：镜像 core.autocrlf / core.eol / core.symlinks 与 info/exclude；
 *   - **快照仓代数（generation）**：整仓被隔离重建或被删后轮换，账本记录据此判定过期；
 *   - 越界与不安全路径：所有写盘路径都过 `utils/paths.ts` 的词法 + 父级符号链接校验；
 *   - 不在快照范围内却不该静默漏掉的东西（超大文件、嵌套 Git 仓库）排除并记录进账本。
 */

import type {
  CaptureLimits,
  CaptureOptions,
  CaptureResult,
  RestoreReport,
  SnapshotStore,
  TurnFileChange,
} from '../types'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { defineService, DSH_HOME } from 'dsh-tauri'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import {
  GIT_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SNAPSHOT,
  MAX_OVERSIZED_SKIPS,
  MAX_SNAPSHOT_BYTES,
  REASON_NON_EMPTY_DIR,
  REASON_SNAPSHOT_FAILED,
  REASON_SNAPSHOT_TOO_LARGE,
  REASON_TOO_MANY_FILES,
  REASON_TOO_MANY_OVERSIZED,
  REASON_UNSAFE_PATH,
  SNAPSHOT_FEATURE_DIR,
  SNAPSHOT_REF_PREFIX,
} from '../config/constants'
import { gitInRepo, gitInSnapshot, resolveSourceCommonDir } from '../utils/git'
import { assertSafeParents, removeCreatedPath, resolveInsideWorkspace } from '../utils/paths'
import { workspaceHash } from '../utils/workspace'

/** commit-tree 的身份（私有仓的提交只做锚点，不代表用户，故用固定身份）。 */
const SNAPSHOT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'DSH Turn Rewind',
  GIT_AUTHOR_EMAIL: 'turnrewind@localhost',
  GIT_COMMITTER_NAME: 'DSH Turn Rewind',
  GIT_COMMITTER_EMAIL: 'turnrewind@localhost',
}

/** 随源仓库同步的配置键：影响 add 的归一化与 checkout 的还原方式。 */
const MIRRORED_CONFIG_KEYS = ['core.autocrlf', 'core.eol', 'core.symlinks']

/** 一次 checkout 调用携带的最大路径数（Windows argv 上限友好）。 */
const CHECKOUT_CHUNK = 200

/** 「体积超限 → 排除最大文件重试」与「解析出嵌套仓库 → 排除重试」的次数上限。 */
const MAX_OVERSIZE_ATTEMPTS = 2
const MAX_NESTED_ATTEMPTS = 3

export const snapshot = defineService({
  /** 某工作区对应的私有快照仓定位。 */
  resolve(worktree: string, commonDir?: string | null): SnapshotStore {
    return {
      worktree,
      gitDir: join(snapshotWorkspacesDir(), `${workspaceHash(worktree)}.git`),
      commonDir: commonDir ?? null,
    }
  },

  /** 快照 ref 名；会话 id 先做文件系统/ref 安全化，再拼短哈希防撞。 */
  ref(sessionId: string, turn: number, phase: 'before' | 'after'): string {
    const sanitized = sessionId.replace(/[^\w.-]/g, '_').slice(0, 64) || 'session'
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
    return `${SNAPSHOT_REF_PREFIX}/${sanitized}-${digest}/${turn}/${phase}`
  },

  /** 有界扫描嵌套 Git 仓库（根 + 两级，跳过噪音目录）。 */
  scan(worktree: string): string[] {
    return scanNestedRepos(worktree)
  },

  /** 读取某工作区当前代数（撤销路径用；不存在返回 null）。 */
  async generation(worktree: string): Promise<string | null> {
    const marker = await readMarker(workspaceMarkerPath(snapshot.resolve(worktree)))
    return marker?.generation ?? null
  },

  /** 轮换快照仓代数：整仓被删/被隔离重建后调用，旧记录据此自然过期。 */
  async rotate(store: SnapshotStore, reason?: string): Promise<string> {
    const generation = randomUUID()
    await writeMarker(workspaceMarkerPath(store), { generation, rebuiltAt: Date.now() })
    store.generation = generation
    if (reason !== undefined)
      store.rebuiltReason = reason
    return generation
  },

  /**
   * 捕获一次快照：`add --all`（带排除）→ `write-tree` → `commit-tree` → `update-ref`。
   *
   * 体积超限时先排除最大的那几个文件重试（并回传给调用方持久化，后续 turn 不必再重捕），
   * 否则一个巨大的构建产物会让整个工作区的撤销能力永久不可用且原因不可读。
   */
  async capture(store: SnapshotStore, ref: string, message: string, options: CaptureOptions = {}): Promise<CaptureResult> {
    if (!isSafeRef(ref))
      return { ok: false, reason: REASON_SNAPSHOT_FAILED }
    const limits: CaptureLimits = {
      maxFileBytes: options.limits?.maxFileBytes ?? MAX_FILE_BYTES,
      maxSnapshotBytes: options.limits?.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES,
      maxFiles: options.limits?.maxFiles ?? MAX_FILES_PER_SNAPSHOT,
    }
    const ready = await ensureSnapshotRepo(store)
    if (!ready.ok)
      return { ok: false, reason: ready.reason }

    const excluded = new Set(options.exclude ?? [])
    const nestedDirs = new Set(options.nestedDirs ?? scanNestedRepos(store.worktree))
    for (const dir of nestedDirs)
      excluded.add(dir)
    const learned = new Set<string>()
    const oversizedSkipped = new Set<string>()

    let stats: TreeStats | null = null
    let lockRetried = false
    let oversizeAttempts = 0
    let nestedAttempts = 0

    for (let attempt = 0; attempt < 8; attempt += 1) {
      // 每轮重新过滤：循环里还会学到新的排除项（嵌套仓库/超限文件），而**被忽略的路径
      // 一旦出现在 exclude pathspec 里就会让 git add 直接失败**（见 dropIgnoredExclusions）。
      const activeExclude = await dropIgnoredExclusions(store, [...excluded])
      // 已被排除的路径必须从 index 里移除：否则上一轮捕获留下的 blob 仍在树里，
      // 体积统计与「已排除」的记录会对不上。
      if (activeExclude.length > 0)
        await gitInSnapshot(store, ['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...activeExclude])
      const added = await gitInSnapshot(store, ['add', '--all', '--', '.', ...excludePathspecs(activeExclude, nestedDirs)])
      if (!added.ok) {
        const nested = parseNestedRepoPath(added.error)
        if (nested !== null && !excluded.has(nested) && nestedAttempts < MAX_NESTED_ATTEMPTS) {
          excluded.add(nested)
          nestedDirs.add(nested)
          learned.add(nested)
          nestedAttempts += 1
          continue
        }
        if (/index\.lock/.test(added.error) && !lockRetried) {
          sweepStaleIndexLock(store)
          lockRetried = true
          continue
        }
        return { ok: false, reason: REASON_SNAPSHOT_FAILED }
      }
      const tree = await gitInSnapshot(store, ['write-tree'])
      if (!tree.ok)
        return { ok: false, reason: REASON_SNAPSHOT_FAILED }
      const counted = await treeStats(store, tree.out.trim(), limits.maxFileBytes)
      if (!counted.ok)
        return { ok: false, reason: REASON_SNAPSHOT_FAILED }
      stats = counted.stats

      if (stats.files > limits.maxFiles)
        return { ok: false, reason: REASON_TOO_MANY_FILES }

      if (stats.bytes > limits.maxSnapshotBytes) {
        // 超限文件太多时不逐个排除（argv 与重试成本都会爆），如实记不可用。
        if (stats.oversized.length > MAX_OVERSIZED_SKIPS)
          return { ok: false, reason: REASON_TOO_MANY_OVERSIZED }
        const candidates = stats.oversized
          .filter(entry => !excluded.has(entry.path))
          .slice(0, MAX_OVERSIZED_SKIPS)
        if (candidates.length === 0 || oversizeAttempts >= MAX_OVERSIZE_ATTEMPTS)
          return { ok: false, reason: REASON_SNAPSHOT_TOO_LARGE }
        for (const entry of candidates) {
          excluded.add(entry.path)
          oversizedSkipped.add(entry.path)
          learned.add(entry.path)
        }
        oversizeAttempts += 1
        continue
      }

      const commit = await gitInSnapshot(store, ['commit-tree', tree.out.trim(), '-m', message], { env: SNAPSHOT_IDENTITY })
      if (!commit.ok)
        return { ok: false, reason: REASON_SNAPSHOT_FAILED }
      const updated = await gitInSnapshot(store, ['update-ref', ref, commit.out.trim()])
      if (!updated.ok)
        return { ok: false, reason: REASON_SNAPSHOT_FAILED }
      return {
        ok: true,
        commit: commit.out.trim(),
        skippedOversized: [...new Set([...oversizedSkipped, ...(options.exclude ?? []).filter(path => !nestedDirs.has(path))])].filter(path => path.length > 0),
        skippedNestedRepos: [...new Set([...nestedDirs, ...stats.gitlinks])].filter(path => path.length > 0),
        learnedExclusions: [...learned],
      }
    }
    return { ok: false, reason: REASON_SNAPSHOT_TOO_LARGE }
  },

  /** 删除快照 ref（账本过期/淘汰后调用），失败忽略。 */
  async remove(store: SnapshotStore, refs: readonly string[]): Promise<void> {
    for (const ref of refs) {
      if (isSafeRef(ref))
        await gitInSnapshot(store, ['update-ref', '-d', ref])
    }
  },

  /** 解析 ref 指向的 commit；不存在返回 null。 */
  async read(store: SnapshotStore, ref: string): Promise<string | null> {
    if (!isSafeRef(ref))
      return null
    const result = await gitInSnapshot(store, ['rev-parse', '--verify', '--quiet', ref])
    if (!result.ok)
      return null
    const oid = result.out.trim()
    return oid.length > 0 ? oid : null
  },

  /**
   * 计算两个快照之间的逐文件差异（`+N -M` 与新增/修改/删除）。
   * 状态由两侧路径集合推导：只看 after 有=A，只看 before 有=D，两侧都有=M。
   */
  async diff(store: SnapshotStore, beforeCommit: string, afterCommit: string): Promise<{ ok: true, changes: TurnFileChange[] } | { ok: false, reason: string }> {
    const [before, after, numstat] = await Promise.all([
      treePaths(store, beforeCommit),
      treePaths(store, afterCommit),
      gitInSnapshot(store, ['diff', '--numstat', '-z', '--no-renames', beforeCommit, afterCommit]),
    ])
    if (!before.ok)
      return { ok: false, reason: before.reason }
    if (!after.ok)
      return { ok: false, reason: after.reason }
    if (!numstat.ok)
      return { ok: false, reason: numstat.error }
    const changes: TurnFileChange[] = []
    for (const record of splitNul(numstat.out)) {
      const firstTab = record.indexOf('\t')
      const secondTab = record.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0)
        continue
      const rawInsertions = record.slice(0, firstTab)
      const rawDeletions = record.slice(firstTab + 1, secondTab)
      const path = record.slice(secondTab + 1)
      if (path.length === 0)
        continue
      const binary = rawInsertions === '-' || rawDeletions === '-'
      changes.push({
        path,
        status: !before.paths.has(path) ? 'A' : !after.paths.has(path) ? 'D' : 'M',
        insertions: binary ? null : Number(rawInsertions),
        deletions: binary ? null : Number(rawDeletions),
        binary,
      })
    }
    changes.sort((left, right) => left.path.localeCompare(right.path))
    return { ok: true, changes }
  },

  /**
   * 运行中实时统计：刷新私有 index 后与 before 快照比较当前工作区。
   *
   * 必须先 `add --all` 再 diff：`git diff <commit>` 只认提交与 index 里出现过的路径，
   * 本轮新建的文件在 index 里还不存在，不刷新就会漏掉它们。
   *
   * 排除清单在两条命令里的用法不一样：`git add` 用剔除被忽略项的结果（指向被忽略目录的
   * exclude pathspec 会让 git add 直接失败），`git diff` 必须带**完整**排除清单，
   * 否则嵌套仓库会作为 gitlink 被报成「本轮新增的文件」。
   */
  async live(store: SnapshotStore, beforeCommit: string, options: CaptureOptions = {}): Promise<{ ok: true, stats: { fileCount: number, insertions: number, deletions: number } } | { ok: false, reason: string }> {
    // 目录语义的排除必须知道哪些路径是目录，因此把嵌套仓库目录并进同一份排除清单。
    const nestedDirs = new Set(options.nestedDirs ?? [])
    const excluded = [...new Set([...(options.exclude ?? []), ...nestedDirs])]
    const activeExclude = await dropIgnoredExclusions(store, excluded)
    const added = await gitInSnapshot(store, ['add', '--all', '--', '.', ...excludePathspecs(activeExclude, nestedDirs)])
    if (!added.ok)
      return { ok: false, reason: added.error }
    const diffArgs = ['diff', '--numstat', '-z', '--no-renames', beforeCommit]
    if (excluded.length > 0)
      diffArgs.push('--', '.', ...excludePathspecs(excluded, nestedDirs))
    const numstat = await gitInSnapshot(store, diffArgs)
    if (!numstat.ok)
      return { ok: false, reason: numstat.error }
    let fileCount = 0
    let insertions = 0
    let deletions = 0
    for (const record of splitNul(numstat.out)) {
      const firstTab = record.indexOf('\t')
      const secondTab = record.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0)
        continue
      fileCount += 1
      const rawInsertions = record.slice(0, firstTab)
      const rawDeletions = record.slice(firstTab + 1, secondTab)
      if (rawInsertions === '-' || rawDeletions === '-')
        continue
      insertions += Number(rawInsertions)
      deletions += Number(rawDeletions)
    }
    return { ok: true, stats: { fileCount, insertions, deletions } }
  },

  /**
   * 冲突明细：找出「当前磁盘内容 != 该 turn 结束时的快照」的路径。
   *
   * 用 `git diff <afterCommit> -- <paths>` 比较，与快照写入共用同一套换行/属性归一化。
   * 另外三类必须独立拦住：删除态（用户后来重建的同名文件 git diff 看不到）、
   * 不安全路径（父级是符号链接/junction）、A 型目标已变成非空目录。
   */
  async conflicts(store: SnapshotStore, afterCommit: string, changes: readonly TurnFileChange[]): Promise<{ ok: true, conflicts: Array<{ path: string, reason: string }> } | { ok: false, reason: string }> {
    const paths = await conflictPaths(store, afterCommit, changes)
    if (!paths.ok)
      return paths
    const details: Array<{ path: string, reason: string }> = []
    for (const path of paths.paths) {
      const change = changes.find(item => item.path === path)
      let reason = '该文件在 turn 结束后又被修改过'
      if (change !== undefined) {
        const absolute = resolveInsideWorkspace(store.worktree, path)
        if (absolute === null || !assertSafeParents(store.worktree, absolute).ok) {
          reason = REASON_UNSAFE_PATH
        }
        else if (change.status === 'D' && existsSync(absolute)) {
          reason = '该文件在 turn 结束后被重新创建'
        }
        else if (change.status === 'A') {
          try {
            if (lstatSync(absolute).isDirectory())
              reason = REASON_NON_EMPTY_DIR
          }
          catch {
            /* 已不存在：不是冲突 */
          }
        }
      }
      details.push({ path, reason })
    }
    return { ok: true, conflicts: details }
  },

  /**
   * 执行恢复：修改/删除的文件从 before 快照 checkout 回来，本 turn 新增的文件删除。
   *
   * 每条路径在**真正动它之前**重跑一次父级符号链接校验（git 子进程与写盘之间存在
   * TOCTOU 窗口），单路径失败只计入 `failed`，不影响其余路径。
   */
  async restore(store: SnapshotStore, beforeCommit: string, changes: readonly TurnFileChange[]): Promise<RestoreReport> {
    const report: RestoreReport = { restored: [], removed: [], failed: [] }
    const restorable: string[] = []
    for (const change of changes) {
      if (change.status === 'A')
        continue
      const absolute = resolveInsideWorkspace(store.worktree, change.path)
      if (absolute === null) {
        report.failed.push({ path: change.path, reason: REASON_UNSAFE_PATH })
        continue
      }
      const safe = assertSafeParents(store.worktree, absolute)
      if (!safe.ok) {
        report.failed.push({ path: change.path, reason: safe.reason })
        continue
      }
      restorable.push(change.path)
    }
    for (let index = 0; index < restorable.length; index += CHECKOUT_CHUNK) {
      const chunk = restorable.slice(index, index + CHECKOUT_CHUNK)
      // TOCTOU 复检：checkout 子进程启动前再确认一次父级没被换成链接。
      const unsafe = chunk.filter((path) => {
        const absolute = resolveInsideWorkspace(store.worktree, path)
        return absolute === null || !assertSafeParents(store.worktree, absolute).ok
      })
      if (unsafe.length > 0) {
        for (const path of unsafe)
          report.failed.push({ path, reason: REASON_UNSAFE_PATH })
      }
      const safeChunk = chunk.filter(path => !unsafe.includes(path))
      if (safeChunk.length === 0)
        continue
      const checkout = await gitInSnapshot(store, ['checkout', beforeCommit, '--', ...safeChunk])
      if (checkout.ok) {
        report.restored.push(...safeChunk)
        continue
      }
      // 整块失败时退化为逐路径重试，精确定位失败项。
      for (const path of safeChunk) {
        const single = await gitInSnapshot(store, ['checkout', beforeCommit, '--', path])
        if (single.ok)
          report.restored.push(path)
        else
          report.failed.push({ path, reason: single.error })
      }
    }
    for (const change of changes) {
      if (change.status !== 'A')
        continue
      const absolute = resolveInsideWorkspace(store.worktree, change.path)
      if (absolute === null) {
        report.failed.push({ path: change.path, reason: REASON_UNSAFE_PATH })
        continue
      }
      const safe = assertSafeParents(store.worktree, absolute)
      if (!safe.ok) {
        report.failed.push({ path: change.path, reason: safe.reason })
        continue
      }
      const removed = removeCreatedPath(absolute)
      if (!removed.ok) {
        report.failed.push({ path: change.path, reason: removed.reason })
        continue
      }
      await pruneEmptyParents(store.worktree, absolute)
      report.removed.push(change.path)
    }
    return report
  },
})

// --- internal ---

/** 嵌套仓库预扫的深度、目录数与跳过名单（有界扫描，只做启发式）。 */
const NESTED_SCAN_MAX_DEPTH = 2
const NESTED_SCAN_MAX_DIRS = 2000
const NESTED_SCAN_SKIP = new Set(['.git', 'node_modules', '.turnrewind'])

interface WorkspaceMarker {
  generation: string
  rebuiltAt?: number
}

interface TreeStats {
  files: number
  bytes: number
  /** 超过单文件上限的条目（按大小降序），供「排除最大文件后重试」使用。 */
  oversized: Array<{ path: string, size: number }>
  /** 树里的 gitlink（mode 160000 = 嵌套仓库/子模块）：内容不受撤销保护。 */
  gitlinks: string[]
}

/** 快照仓根目录（固定落在 `DSH_HOME` 下）。 */
function snapshotWorkspacesDir(): string {
  return join(DSH_HOME, SNAPSHOT_FEATURE_DIR, 'workspaces')
}

/** 工作区标记文件（代数 + 重建时间的宿主侧真相）；读写两侧必须走同一个拼法。 */
function workspaceMarkerPath(store: SnapshotStore): string {
  return `${store.gitDir}.json`
}

/**
 * 只允许把 `refs/turnrewind/*` 或 40/64 位 oid 插值进 git 参数。
 * 账本是从磁盘读的 JSON，被手改/损坏时不能把任意字符串塞进子进程 argv。
 */
function isSafeRef(value: string, prefix = SNAPSHOT_REF_PREFIX): boolean {
  return value.startsWith(prefix) || /^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value)
}

function splitNul(value: string): string[] {
  if (value.length === 0)
    return []
  const parts = value.split('\0')
  if (parts.at(-1) === '')
    parts.pop()
  return parts
}

function repoExists(store: SnapshotStore): boolean {
  return existsSync(join(store.gitDir, 'HEAD'))
}

async function readMarker(path: string): Promise<WorkspaceMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<WorkspaceMarker>
    if (typeof parsed.generation === 'string' && parsed.generation.length > 0)
      return { generation: parsed.generation, ...(typeof parsed.rebuiltAt === 'number' ? { rebuiltAt: parsed.rebuiltAt } : {}) }
    return null
  }
  catch {
    return null
  }
}

async function writeMarker(path: string, marker: WorkspaceMarker): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

/** 读取当前快照仓代数；标记缺失时按需创建。 */
async function ensureGeneration(store: SnapshotStore): Promise<string> {
  const path = workspaceMarkerPath(store)
  const marker = await readMarker(path)
  if (marker !== null) {
    store.generation = marker.generation
    return marker.generation
  }
  const generation = randomUUID()
  await writeMarker(path, { generation })
  store.generation = generation
  return generation
}

/**
 * 清扫崩溃残骸：私有仓的 `index.lock` 若比 git 的重活预算还旧，说明上一个进程在
 * `git add` 中途死了——不清掉的话之后每次快照都会因锁失败而永久不可用。
 */
function sweepStaleIndexLock(store: SnapshotStore): boolean {
  const lock = join(store.gitDir, 'index.lock')
  try {
    const stats = lstatSync(lock)
    if (Date.now() - stats.mtimeMs <= GIT_TIMEOUT_MS)
      return false
  }
  catch {
    return false
  }
  try {
    unlinkSync(lock)
    return true
  }
  catch {
    // 残骸清扫是 best-effort：清不掉就让后续 git 照常报锁冲突。
    return false
  }
}

/** 首次使用时初始化私有快照仓，并把源仓库的换行/属性配置镜像进来。 */
async function ensureSnapshotRepo(store: SnapshotStore): Promise<{ ok: true } | { ok: false, reason: string }> {
  const existed = repoExists(store)
  if (!existed) {
    // `git init <path>.git` 会在 `<path>.git` 里再套一层 `.git`，而 `--git-dir` 需要目录本身
    // 就是 git dir，因此用 `--bare`。父目录必须先存在，否则 execFile ENOENT。
    const parent = dirname(store.gitDir)
    await mkdir(parent, { recursive: true })
    const init = await gitInRepo(parent, ['init', '--bare', '--quiet', store.gitDir])
    if (!init.ok)
      return { ok: false, reason: REASON_SNAPSHOT_FAILED }
    // 仓库不在（首次使用 / 被删 / 被隔离重建）：轮换代数，让旧记录自然过期。
    await snapshot.rotate(store)
  }
  else {
    await ensureGeneration(store)
    sweepStaleIndexLock(store)
  }
  await gitInSnapshot(store, ['config', 'core.bare', 'false'])
  const configured = await gitInSnapshot(store, ['config', 'core.worktree', store.worktree])
  if (!configured.ok)
    return { ok: false, reason: REASON_SNAPSHOT_FAILED }
  // 私有仓不做自动 gc（避免后台回收与撤销抢锁）：回收由 retention 的显式 prune 负责。
  await gitInSnapshot(store, ['config', 'gc.auto', '0'])
  // 长路径支持：Windows 上超过 MAX_PATH 的路径会让 add/checkout 直接失败。
  await gitInSnapshot(store, ['config', 'core.longpaths', 'true'])
  for (const key of MIRRORED_CONFIG_KEYS) {
    const value = await gitInRepo(store.worktree, ['config', '--get', key])
    const trimmed = value.ok ? value.out.trim() : ''
    if (trimmed.length > 0)
      await gitInSnapshot(store, ['config', key, trimmed])
  }
  await syncSourceExclude(store)
  return { ok: true }
}

/** 把源仓库 `.git/info/exclude` 的内容同步进私有仓（忽略规则语义对齐，best-effort）。 */
async function syncSourceExclude(store: SnapshotStore): Promise<void> {
  const commonDir = store.commonDir ?? await resolveSourceCommonDir(store.worktree)
  if (commonDir === null)
    return
  const absoluteCommon = isAbsolute(commonDir) ? commonDir : resolve(store.worktree, commonDir)
  const sourceFile = join(absoluteCommon, 'info', 'exclude')
  if (!existsSync(sourceFile))
    return
  // 写的是**私有仓**自己的 info/exclude：私有仓的 GIT_DIR 与源仓库不同，
  // 源仓库的 exclude 不会被自动读取，必须显式镜像过来。
  const target = join(store.gitDir, 'info', 'exclude')
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(sourceFile, 'utf8'), 'utf8')
  }
  catch {
    /* 同步失败不影响快照：只是忽略规则可能少一条 */
  }
}

/** 统计一棵树：文件数、聚合字节、超限条目与 gitlink。 */
async function treeStats(store: SnapshotStore, commitOrTree: string, maxFileBytes: number): Promise<{ ok: true, stats: TreeStats } | { ok: false, reason: string }> {
  const listed = await gitInSnapshot(store, ['ls-tree', '-r', '-l', '-z', commitOrTree])
  if (!listed.ok)
    return { ok: false, reason: listed.error }
  const stats: TreeStats = { files: 0, bytes: 0, oversized: [], gitlinks: [] }
  for (const record of splitNul(listed.out)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/.exec(record)
    if (match === null) {
      // 子模块/嵌套仓库（gitlink，无 size 列）：计入文件数，单独记录。
      const gitlink = /^160000 commit [0-9a-f]+\t([\s\S]+)$/.exec(record)
      if (gitlink !== null)
        stats.gitlinks.push(gitlink[1] ?? '')
      stats.files += 1
      continue
    }
    const size = Number(match[4])
    const path = match[5] ?? ''
    stats.files += 1
    stats.bytes += size
    if (size > maxFileBytes)
      stats.oversized.push({ path, size })
  }
  stats.oversized.sort((left, right) => right.size - left.size)
  return { ok: true, stats }
}

/** 把排除路径编译成 git pathspec（目录同时排除自身与内容）。 */
function excludePathspecs(paths: readonly string[], directories: ReadonlySet<string>): string[] {
  const specs: string[] = []
  for (const path of paths) {
    specs.push(`:(exclude)${path}`)
    if (directories.has(path))
      specs.push(`:(exclude,glob)${path}/**`)
  }
  return specs
}

/**
 * 摘掉「已被 git 忽略」的排除路径。
 *
 * `git add --all -- . :(exclude)<ignored>` 会直接失败（`The following paths are ignored
 * by one of your .gitignore files`），而这条错误与「能不能加入」无关。判定必须交给 git
 * 自己（`check-ignore`）而不是自制正则：它和 `git add` 读的是同一份 index 与忽略规则。
 * `check-ignore` 用退出码表达否定答案（exit 1 = 一条都没命中），因此失败分支的 stdout
 * 也要读（见 utils/git.ts）。判定失败时原样保留全部路径：宁可退回改动前的行为。
 */
async function dropIgnoredExclusions(store: SnapshotStore, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0)
    return []
  const listed = await gitInSnapshot(store, ['check-ignore', '-z', '--stdin'], { input: `${paths.join('\0')}\0` })
  if (listed.out.length === 0)
    return [...paths]
  const ignored = new Set(splitNul(listed.out))
  return paths.filter(path => !ignored.has(path))
}

/** 从 git add 的失败信息里解析出「没有提交的嵌套仓库」路径（可能不存在）。 */
function parseNestedRepoPath(error: string): string | null {
  const match = /'([^']+)' does not have a commit checked out/.exec(error)
    ?? /unable to index file '([^']+)'/.exec(error)
  if (match === null)
    return null
  const path = (match[1] ?? '').replace(/[\\/]+$/, '')
  if (path.length === 0 || path.includes('\0') || isAbsolute(path) || path.startsWith('..'))
    return null
  return path
}

/** 有界扫描嵌套 Git 仓库（根 + 两级，跳过噪音目录）。 */
function scanNestedRepos(worktree: string): string[] {
  const found: string[] = []
  let visited = 0
  const walk = (rel: string, depth: number): void => {
    if (depth > NESTED_SCAN_MAX_DEPTH || visited >= NESTED_SCAN_MAX_DIRS)
      return
    const absolute = rel === '' ? worktree : join(worktree, rel)
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (visited >= NESTED_SCAN_MAX_DIRS)
        return
      if (!entry.isDirectory() || NESTED_SCAN_SKIP.has(entry.name))
        continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      visited += 1
      if (existsSync(join(worktree, childRel, '.git'))) {
        found.push(childRel)
        continue
      }
      walk(childRel, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/** 列出某 commit 下的全部路径集合。 */
async function treePaths(store: SnapshotStore, commit: string): Promise<{ ok: true, paths: Set<string> } | { ok: false, reason: string }> {
  const listed = await gitInSnapshot(store, ['ls-tree', '-r', '-z', '--name-only', commit])
  if (!listed.ok)
    return { ok: false, reason: listed.error }
  return { ok: true, paths: new Set(splitNul(listed.out)) }
}

async function conflictPaths(store: SnapshotStore, afterCommit: string, changes: readonly TurnFileChange[]): Promise<{ ok: true, paths: string[] } | { ok: false, reason: string }> {
  const conflicting = new Map<string, string>()
  const tracked = changes.filter(change => change.status !== 'D').map(change => change.path)
  if (tracked.length > 0) {
    const diff = await gitInSnapshot(store, ['diff', '--name-only', '-z', '--no-renames', afterCommit, '--', ...tracked])
    if (!diff.ok)
      return { ok: false, reason: diff.error }
    for (const path of splitNul(diff.out))
      conflicting.set(path, '该文件在 turn 结束后又被修改过')
  }
  for (const change of changes) {
    const absolute = resolveInsideWorkspace(store.worktree, change.path)
    if (absolute === null) {
      conflicting.set(change.path, REASON_UNSAFE_PATH)
      continue
    }
    const safe = assertSafeParents(store.worktree, absolute)
    if (!safe.ok)
      conflicting.set(change.path, REASON_UNSAFE_PATH)
    if (change.status !== 'D')
      continue
    if (existsSync(absolute))
      conflicting.set(change.path, '该文件在 turn 结束后被重新创建')
  }
  return { ok: true, paths: [...conflicting.keys()] }
}

/** 从删除点向上清理空目录（止于工作区根；目录非空即停）。 */
async function pruneEmptyParents(worktree: string, absolutePath: string): Promise<void> {
  let current = dirname(absolutePath)
  while (current.length > 0 && resolve(current) !== resolve(worktree)) {
    try {
      await rmdir(current)
    }
    catch {
      return
    }
    current = dirname(current)
  }
}
