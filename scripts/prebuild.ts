/**
 * prebuild：把 `src-tauri/resources/internal-plugins.json` 中声明的内部插件
 * 制备为随包产物，拷入 `src-tauri/resources/internal-plugins/<id>/`
 * （随 `bundle.resources` 随安装包分发）。两种来源：
 *
 * - `github:owner/repo`：从上游仓库克隆、安装依赖并构建（源码形态的插件）；
 * - npm 包名（`name[@version]`）：从 npm registry 拉取已发布产物，跳过构建
 *   （发布包自带 lib/，如 dsh-tauri@0.2.0）。
 *
 * 由 `pnpm build` 的 prebuild 生命周期自动触发（tauri 的 `beforeBuildCommand` 为
 * `pnpm build`，pnpm 先执行 `prebuild` 脚本）。应用启动时（service::plugin::internal）
 * 会核对内置插件是否已安装、安装路径是否仍指向该捆绑目录，未满足即强制重装。
 *
 * 约束：仅用 Node 内置模块（零新增依赖）；需要 git 与 pnpm 在 PATH 上；
 * 构建机器需可访问 GitHub 与 npm registry。通过 `tsx scripts/prebuild.ts`
 * 直接运行（TS + ESM），无需预编译。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  win32,
} from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface InternalPlugin {
  id: string
  spec: string
  integrity?: string
  commit?: string
}

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..')
const INTERNAL_PLUGINS_FILE = join(REPO_ROOT, 'src-tauri', 'resources', 'internal-plugins.json')
const BUNDLE_ROOT = join(REPO_ROOT, 'src-tauri', 'resources', 'internal-plugins')
const PLUGIN_ID_RE = /^(?:@[\w.-]+\/)?\w[\w.-]{0,127}$/
const GITHUB_SPEC_RE = /^github:([\w.-]+\/[\w.-]+)(?:#([^#\s]+))?$/
const NPM_SPEC_RE = /^(@[\w.-]+\/\w[\w.-]*|\w[\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/i
const NPM_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const NPM_REGISTRY = 'https://registry.npmjs.org/'

interface CommandInvocation {
  executable: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

function die(message: string): never {
  console.error(`[prebuild] ${message}`)
  process.exit(1)
}

/** 同步执行命令，非零退出码即终止构建（内置插件缺失是发布缺陷，必须响亮失败）。 */
function run(program: string, args: readonly string[], cwd: string): void {
  console.log(`[prebuild] $ ${program} ${args.join(' ')}`)
  let invocation: CommandInvocation
  try {
    invocation = buildCommandInvocation(program, args)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    die(`${program} 参数不安全: ${message}`)
  }
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  })
  if (result.error !== undefined) {
    die(`${program} 启动失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    die(`${program} ${args.join(' ')} 退出码 ${result.status}`)
  }
}

function quoteCmdArgument(value: string): string {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(`unsafe command argument: ${value}`)
  }
  return `"${value}"`
}

export function buildCommandInvocation(
  program: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): CommandInvocation {
  if (platform !== 'win32' || (program !== 'npm' && program !== 'pnpm')) {
    return { executable: program, args: [...args] }
  }

  const command = [`${program}.cmd`, ...args].map(quoteCmdArgument).join(' ')
  return {
    executable: comspec,
    args: ['/d', '/v:off', '/s', '/c', command],
    windowsVerbatimArguments: true,
  }
}

export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0
    && ref.length <= 256
    && startsWithAsciiAlphaNumeric(ref)
    && /^\w[\w./-]*$/.test(ref)
    && !ref.includes('..')
    && !ref.includes('//')
    && !ref.includes('@{')
    && !ref.endsWith('.')
    && !ref.endsWith('/')
}

function startsWithAsciiAlphaNumeric(value: string): boolean {
  const code = value.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

export function parseGithubSpec(spec: string): { repo: string, ref?: string } | undefined {
  const match = GITHUB_SPEC_RE.exec(spec)
  if (match === null) {
    return undefined
  }
  if (match[1].split('/').some(part => !startsWithAsciiAlphaNumeric(part))) {
    return undefined
  }
  const ref = match[2]
  if (ref !== undefined && !isSafeGitRef(ref)) {
    die(`Git ref 不安全: ${ref}`)
  }
  return { repo: match[1], ref }
}

export function parseNpmSpec(spec: string): { name: string, version: string } | undefined {
  const match = NPM_SPEC_RE.exec(spec)
  if (match === null || !isValidNpmVersion(match[2])) {
    return undefined
  }
  const packageName = match[1].startsWith('@') ? match[1].slice(match[1].indexOf('/') + 1) : match[1]
  return startsWithAsciiAlphaNumeric(packageName) ? { name: match[1], version: match[2] } : undefined
}

function isValidNpmVersion(version: string): boolean {
  return !version.includes('_')
    && !version.includes('..')
    && !version.endsWith('.')
    && !version.endsWith('-')
}

/** `github:owner/repo[#ref]` → 可克隆的 https URL，并保留独立校验的 ref。 */
function githubUrl(spec: string): string {
  const parsed = parseGithubSpec(spec)
  if (parsed === undefined) {
    die(`internal 插件 spec 必须是 github:owner/repo 形式，当前为: ${spec}`)
  }
  return `https://github.com/${parsed.repo.replace(/\.git$/, '')}.git`
}

export function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 1024
    && !value.includes('\0')
    && !value.includes('\\')
    && !value.includes(':')
    && !/[<>"|?*]/.test(value)
    && !isAbsolute(value)
    && !posix.isAbsolute(value)
    && !win32.isAbsolute(value)
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

function safeJoin(root: string, child: string, label: string): string {
  if (!isSafeRelativePath(child)) {
    die(`${label}: 路径必须是安全的相对路径: ${child}`)
  }
  const rootPath = resolve(root)
  const childPath = resolve(rootPath, child)
  const relativePath = relative(rootPath, childPath)
  if (relativePath === '' || /^\.\.(?:[\\/]|$)/.test(relativePath) || isAbsolute(relativePath)) {
    die(`${label}: 路径越过允许目录: ${child}`)
  }
  return childPath
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    die(`${label}: JSON 无法解析: ${message}`)
  }
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    die(`${label}: JSON 顶层必须是对象`)
  }
  return value as Record<string, unknown>
}

export function validateManifest(): InternalPlugin[] {
  const parsed = readJson(INTERNAL_PLUGINS_FILE, INTERNAL_PLUGINS_FILE)
  if (!Array.isArray(parsed)) {
    die(`内部插件清单必须是数组: ${INTERNAL_PLUGINS_FILE}`)
  }

  const ids = new Set<string>()
  return parsed.map((value, index) => {
    const record = jsonObject(value, `内部插件清单第 ${index + 1} 项`)
    const id = record.id
    const spec = record.spec
    if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) {
      die(`内部插件清单第 ${index + 1} 项的 id 非法: ${String(id)}`)
    }
    const pluginName = id.startsWith('@') ? id.slice(id.indexOf('/') + 1) : id
    if (!startsWithAsciiAlphaNumeric(pluginName)) {
      die(`内部插件清单第 ${index + 1} 项的 id 非法: ${id}`)
    }
    const normalizedId = id.toLowerCase()
    if (ids.has(normalizedId)) {
      die(`内部插件清单存在重复 id: ${id}`)
    }
    ids.add(normalizedId)
    if (typeof spec !== 'string') {
      die(`${id}: spec 必须是字符串`)
    }

    const github = parseGithubSpec(spec)
    const npm = parseNpmSpec(spec)
    if (github === undefined && npm === undefined) {
      die(`${id}: spec 必须是 github:owner/repo[#ref] 或精确 npm 版本: ${spec}`)
    }

    if (github !== undefined) {
      if (typeof record.commit !== 'string' || !GIT_COMMIT_RE.test(record.commit)) {
        die(`${id}: Git 来源必须提供完整 40 位 commit SHA`)
      }
      return { id, spec, commit: record.commit.toLowerCase() }
    }

    if (typeof record.integrity !== 'string' || !NPM_INTEGRITY_RE.test(record.integrity)) {
      die(`${id}: npm 来源必须提供 sha512 integrity`)
    }
    return { id, spec, integrity: record.integrity }
  })
}

/**
 * 从 npm registry 下载已发布 tarball，先核对清单摘要，再让 pnpm 从已核对的
 * 本地 tarball 安装到临时工程，避免直接信任动态 registry 响应。
 */
function fetchNpmPackage(preset: InternalPlugin, temp: string): string {
  const npm = parseNpmSpec(preset.spec)
  if (npm === undefined || preset.integrity === undefined) {
    die(`${preset.id}: npm 来源配置不完整`)
  }

  const packDir = join(temp, 'pack')
  mkdirSync(packDir, { recursive: true })
  run('npm', [
    'pack',
    preset.spec,
    '--ignore-scripts',
    '--registry',
    NPM_REGISTRY,
    '--pack-destination',
    packDir,
  ], temp)
  const tarballs = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    die(`${preset.id}: npm pack 未生成唯一 tarball`)
  }
  const tarball = join(packDir, tarballs[0])
  const actualIntegrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  if (actualIntegrity !== preset.integrity) {
    die(`${preset.id}: npm integrity 校验失败，期望 ${preset.integrity}，实际 ${actualIntegrity}`)
  }

  const project = join(temp, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true }))
  run('pnpm', ['add', tarball, '--ignore-scripts', '--registry', NPM_REGISTRY], project)
  const pkgDir = join(project, 'node_modules', npm.name)
  if (!existsSync(join(pkgDir, 'package.json'))) {
    die(`${preset.id}: npm 安装后未找到产物 ${pkgDir}`)
  }
  const source = realpathSync(pkgDir)
  const packageManifest = jsonObject(
    readJson(join(source, 'package.json'), `${preset.id}: package.json`),
    `${preset.id}: package.json`,
  )
  if (packageManifest.name !== npm.name || packageManifest.version !== npm.version) {
    die(`${preset.id}: npm 包身份与清单不一致`)
  }
  console.log(`[prebuild] ${preset.id}: 来源 npm ${preset.spec} (${preset.integrity})`)
  return source
}

function assertNoSymlinks(path: string, label: string): void {
  let stat
  try {
    stat = lstatSync(path)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    die(`${label}: 无法读取文件: ${message}`)
  }
  if (stat.isSymbolicLink()) {
    die(`${label}: 拒绝复制符号链接: ${path}`)
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assertNoSymlinks(join(path, entry.name), label)
    }
  }
}

/**
 * 拷贝构建产物：优先 `files` 白名单（只发运行必需：lib/、patch 文件、README），
 * 缺失白名单时拷贝整目录但排除 node_modules/.git 等开发噪声；
 * `package.json` 恒在（它是 `pnpm add file:<dir>` 的包名/入口来源）。
 */
function collectBundle(preset: InternalPlugin, clone: string): void {
  const dest = safeJoin(BUNDLE_ROOT, preset.id, `${preset.id}: 目标目录`)
  mkdirSync(dest, { recursive: true })

  const sourceRoot = realpathSync(clone)
  const packageJson = safeJoin(sourceRoot, 'package.json', `${preset.id}: package.json`)
  const manifest = jsonObject(readJson(packageJson, `${preset.id}: package.json`), `${preset.id}: package.json`)
  const rawFiles = manifest.files
  if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
    die(`${preset.id}: package.json 的 files 必须是字符串数组`)
  }
  const files = rawFiles === undefined ? undefined : rawFiles as unknown[]
  const skip = new Set(['node_modules', '.git', '.gitignore', '.npmrc'])
  const entries = files !== undefined && files.length > 0
    ? files.map((name, index) => {
        if (typeof name !== 'string') {
          die(`${preset.id}: files[${index}] 必须是字符串`)
        }
        return name
      })
    : readdirSync(sourceRoot).filter(name => !skip.has(name) && !name.endsWith('.tsbuildinfo'))

  for (const name of entries) {
    const src = safeJoin(sourceRoot, name, `${preset.id}: files`)
    if (!existsSync(src)) {
      die(`${preset.id}: 白名单产物缺失 ${src}`)
    }
    assertNoSymlinks(src, `${preset.id}: files`)
    const target = safeJoin(dest, name, `${preset.id}: bundle`)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(src, target, { recursive: true, verbatimSymlinks: true })
  }
  // 拷贝后置，确保即使白名单里没有 package.json 它也一定存在
  assertNoSymlinks(packageJson, `${preset.id}: package.json`)
  cpSync(packageJson, safeJoin(dest, 'package.json', `${preset.id}: bundle`))
}

/** 构建单个 internal 插件：git 来源（克隆 → 装依赖 → 构建）或 npm 来源（拉产物）。 */
function buildPlugin(preset: InternalPlugin): void {
  const dest = safeJoin(BUNDLE_ROOT, preset.id, `${preset.id}: 目标目录`)
  rmSync(dest, { recursive: true, force: true })

  const temp = mkdtempSync(join(tmpdir(), `dsh-internal-${preset.id}-`))
  let source: string
  const github = parseGithubSpec(preset.spec)
  if (github !== undefined) {
    const clone = join(temp, preset.id)
    if (github === undefined || preset.commit === undefined) {
      die(`${preset.id}: Git 来源配置不完整`)
    }
    const cloneArgs = ['clone', '--depth', '1', '--no-tags', '--single-branch', '--quiet']
    if (github.ref !== undefined) {
      cloneArgs.push('--branch', github.ref)
    }
    cloneArgs.push(githubUrl(preset.spec), clone)
    run('git', cloneArgs, temp)

    const revision = spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false })
    if (revision.error !== undefined || revision.status !== 0) {
      die(`${preset.id}: 无法读取 Git commit`)
    }
    const actualCommit = revision.stdout.trim()
    if (!GIT_COMMIT_RE.test(actualCommit) || actualCommit.toLowerCase() !== preset.commit) {
      die(`${preset.id}: Git commit 校验失败，期望 ${preset.commit}，实际 ${actualCommit}`)
    }
    console.log(`[prebuild] ${preset.id}: 来源修订 ${actualCommit}`)

    // 注意：pnpm ≥10 默认拦截依赖的构建脚本（esbuild/原生模块需在插件仓库
    // 的 pnpm-workspace.yaml 配 onlyBuiltDependencies 放行）；纯 JS/TS 插件不受影响。
    run('pnpm', ['install'], clone)
    const manifest = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    if (manifest.scripts?.build !== undefined) {
      run('pnpm', ['run', 'build'], clone)
    }
    source = clone
  }
  else {
    source = fetchNpmPackage(preset, temp)
  }

  collectBundle(preset, source)
  rmSync(temp, { recursive: true, force: true })
  console.log(`[prebuild] ${preset.id}: 产物已就绪 → ${dest}`)
}

function main(): void {
  if (!existsSync(INTERNAL_PLUGINS_FILE)) {
    die(`未找到内部插件清单 ${INTERNAL_PLUGINS_FILE}`)
  }
  const internal = validateManifest()
  if (internal.length === 0) {
    console.log('[prebuild] 内部插件清单为空，跳过')
    return
  }
  console.log(`[prebuild] 拉取 ${internal.length} 个 internal 插件: ${internal.map(p => p.id).join(', ')}`)
  for (const plugin of internal) {
    buildPlugin(plugin)
  }
  console.log(`[prebuild] 完成 → ${BUNDLE_ROOT}`)
}

export function isDirectEntry(entry: string | undefined, scriptPath: string): boolean {
  if (entry === undefined) {
    return false
  }
  try {
    return realpathSync(resolve(entry)) === realpathSync(resolve(scriptPath))
  }
  catch {
    return resolve(entry) === resolve(scriptPath)
  }
}

if (isDirectEntry(process.argv[1], SCRIPT_PATH)) {
  main()
}
