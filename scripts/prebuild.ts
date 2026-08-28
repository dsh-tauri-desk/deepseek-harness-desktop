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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

interface InternalPlugin {
  id: string
  spec: string
}

const REPO_ROOT = resolve(import.meta.dirname, '..')
const INTERNAL_PLUGINS_FILE = join(REPO_ROOT, 'src-tauri', 'resources', 'internal-plugins.json')
const BUNDLE_ROOT = join(REPO_ROOT, 'src-tauri', 'resources', 'internal-plugins')
const GIT_URL_RE = /^github:([^#/]+\/[^#/]+)(?:#.*)?$/

function die(message: string): never {
  console.error(`[prebuild] ${message}`)
  process.exit(1)
}

/** 同步执行命令，非零退出码即终止构建（内置插件缺失是发布缺陷，必须响亮失败）。 */
function run(program: string, args: readonly string[], cwd: string): void {
  console.log(`[prebuild] $ ${program} ${args.join(' ')}`)
  const result = spawnSync(program, [...args], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    die(`${program} 启动失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    die(`${program} ${args.join(' ')} 退出码 ${result.status}`)
  }
}

/** `github:owner/repo[#ref]` → 可克隆的 https URL（忽略 ref，拉默认分支最新）。 */
function githubUrl(spec: string): string {
  const match = GIT_URL_RE.exec(spec)
  if (match === null) {
    die(`internal 插件 spec 必须是 github:owner/repo 形式，当前为: ${spec}`)
  }
  const repo = match[1].replace(/\.git$/, '')
  return `https://github.com/${repo}.git`
}

/** `name[@version]`（含 scoped `@scope/name[@version]`）→ 裸包名，用于定位 node_modules。 */
function npmPackageName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? spec.indexOf('/') + 1 : 0)
  return at === -1 ? spec : spec.slice(0, at)
}

/**
 * 从 npm registry 拉取已发布产物：临时工程里 `pnpm add <spec>`，产物即
 * `node_modules/<name>/`（发布包自带 lib/ 等运行必需文件，无需再构建）。
 * 依赖 pnpm 在 PATH 上（与 git 来源流程同一前提）。
 */
function fetchNpmPackage(preset: InternalPlugin, temp: string): string {
  const project = join(temp, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true }))
  run('pnpm', ['add', preset.spec, '--ignore-scripts'], project)
  const pkgDir = join(project, 'node_modules', npmPackageName(preset.spec))
  if (!existsSync(join(pkgDir, 'package.json'))) {
    die(`${preset.id}: npm 安装后未找到产物 ${pkgDir}`)
  }
  console.log(`[prebuild] ${preset.id}: 来源 npm ${preset.spec}`)
  return pkgDir
}

/**
 * 拷贝构建产物：优先 `files` 白名单（只发运行必需：lib/、patch 文件、README），
 * 缺失白名单时拷贝整目录但排除 node_modules/.git 等开发噪声；
 * `package.json` 恒在（它是 `pnpm add file:<dir>` 的包名/入口来源）。
 */
function collectBundle(preset: InternalPlugin, clone: string): void {
  const dest = join(BUNDLE_ROOT, preset.id)
  mkdirSync(dest, { recursive: true })

  const manifest = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')) as Record<string, unknown>
  const rawFiles = manifest.files
  const files = Array.isArray(rawFiles)
    ? rawFiles.filter((f): f is string => typeof f === 'string')
    : undefined
  const skip = new Set(['node_modules', '.git', '.gitignore', '.npmrc'])
  const entries = files !== undefined && files.length > 0
    ? files
    : readdirSync(clone).filter(name => !skip.has(name) && !name.endsWith('.tsbuildinfo'))

  for (const name of entries) {
    const src = join(clone, name)
    if (!existsSync(src)) {
      die(`${preset.id}: 白名单产物缺失 ${src}`)
    }
    cpSync(src, join(dest, name), { recursive: true })
  }
  // 拷贝后置，确保即使白名单里没有 package.json 它也一定存在
  cpSync(join(clone, 'package.json'), join(dest, 'package.json'))
}

/** 构建单个 internal 插件：git 来源（克隆 → 装依赖 → 构建）或 npm 来源（拉产物）。 */
function buildPlugin(preset: InternalPlugin): void {
  const dest = join(BUNDLE_ROOT, preset.id)
  rmSync(dest, { recursive: true, force: true })

  const temp = mkdtempSync(join(tmpdir(), `dsh-internal-${preset.id}-`))
  let source: string
  if (preset.spec.startsWith('github:')) {
    const clone = join(temp, preset.id)
    run('git', ['clone', '--depth', '1', '--quiet', githubUrl(preset.spec), clone], temp)

    const revision = spawnSync('git', ['-C', clone, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    if (revision.status === 0) {
      console.log(`[prebuild] ${preset.id}: 来源修订 ${revision.stdout.trim()}`)
    }

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
  const internal = JSON.parse(readFileSync(INTERNAL_PLUGINS_FILE, 'utf8')) as InternalPlugin[]
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

main()
