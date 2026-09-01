import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_ROOT = join(REPO_ROOT, 'packages')
const BUNDLE_PACKAGE = join(PACKAGES_ROOT, 'dsh-tauri-bundle', 'package.json')
const RESOURCE_ROOT = join(REPO_ROOT, 'src-tauri', 'resources')
/** 运行期实际依赖的部署产物：`resources/node_modules/<name>`（Tauri 只捆绑 `resources/**`） */
const DEPLOYED_NODE_MODULES = join(RESOURCE_ROOT, 'node_modules')

function run(args: readonly string[]): void {
  console.log(`[build:plugins] $ pnpm ${args.join(' ')}`)
  const result = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    throw new Error(`PNPM_START_FAILED: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`PNPM_COMMAND_FAILED: pnpm ${args.join(' ')} exited with ${result.status}`)
  }
}

function bundledPackageNames(): string[] {
  if (!existsSync(BUNDLE_PACKAGE)) {
    throw new Error(`PLUGIN_BUNDLE_MANIFEST_MISSING: ${BUNDLE_PACKAGE}`)
  }
  const manifest = JSON.parse(readFileSync(BUNDLE_PACKAGE, 'utf8')) as {
    dependencies?: Record<string, unknown>
  }
  const names = Object.keys(manifest.dependencies ?? {})
  if (names.length === 0) {
    throw new Error('PLUGIN_BUNDLE_EMPTY: dsh-tauri-bundle must depend on plugins')
  }
  return names
}

function verifyDeployedPackages(names: readonly string[], nodeModulesRoot: string): void {
  for (const name of names) {
    const packageJson = join(nodeModulesRoot, name, 'package.json')
    if (!existsSync(packageJson)) {
      throw new Error(`PLUGIN_DEPLOY_MISSING: ${packageJson}`)
    }
    const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      main?: unknown
      dsh?: unknown
    }
    if (typeof manifest.dsh !== 'object' || manifest.dsh === null || Array.isArray(manifest.dsh)) {
      throw new Error(`PLUGIN_DEPLOY_INVALID_DSH: ${packageJson}`)
    }
    if (typeof manifest.main === 'string' && !existsSync(join(nodeModulesRoot, name, manifest.main))) {
      throw new Error(`PLUGIN_DEPLOY_MISSING_ENTRY: ${join(nodeModulesRoot, name, manifest.main)}`)
    }
  }
}

/**
 * 把 `pnpm deploy` 产物解引用复制到目标目录：pnpm 虚拟仓库（`.pnpm` 下的依赖入口）
 * 全是符号链接，必须逐条按「链接目标」的真实类型落成实体目录/文件。
 *
 * 为什么不用 `fs.cpSync(..., { dereference: true })`：Node 22.17 起该选项失效
 * （regression nodejs/node#59168），符号链接会被原样重建成指向**源目录**的绝对链接。
 * 本脚本的源目录是随后即删的临时目录 `.build-plugins-tmp`，于是产物里留下一堆悬垂
 * 链接；`tauri build` 展开 `bundle.resources` 通配时逐条登记资源，命中悬垂链接即以
 * `resource path ... doesn't exist` 失败（macOS / Linux 复现；Windows 因链接形态不同
 * 未触发，故只挂了两个平台）。
 *
 * `chain` 为当前递归路径上已展开目录的 realpath 集合，用于挡住链接成环的无限递归。
 */
function materializeTree(source: string, target: string, chain: ReadonlySet<string> = new Set()): void {
  const sourceReal = realpathSync(source)
  if (chain.has(sourceReal)) {
    throw new Error(`PLUGIN_DEPLOY_SYMLINK_CYCLE: ${source} -> ${sourceReal}`)
  }
  const nested = new Set(chain).add(sourceReal)
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    // statSync 跟随符号链接：按链接目标的类型决定复制方式，源里是不是链接无关紧要。
    const stats = statSync(from)
    if (stats.isDirectory()) {
      materializeTree(from, to, nested)
      continue
    }
    if (!stats.isFile()) {
      throw new Error(`PLUGIN_DEPLOY_UNSUPPORTED_ENTRY: ${from}`)
    }
    // copyFileSync 读取链接目标的内容，并保留源文件权限位（可执行脚本仍可执行）。
    copyFileSync(from, to)
  }
}

/**
 * 校验产物中不再残留任何符号链接。Tauri 打包会把资源通配展开成逐条路径，悬垂链接
 * 要到 cargo 构建脚本阶段才报错，离根因很远；宁可在这里带 `PLUGIN_DEPLOY_` 前缀早失败。
 */
function verifyMaterialized(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`PLUGIN_DEPLOY_SYMLINK_LEFTOVER: ${join(entry.parentPath, entry.name)}`)
    }
  }
}

function main(): void {
  const names = bundledPackageNames()
  // 先生成最新 dist，再打包 production 闭包。部署到独立临时目录并校验通过后，
  // 才把自包含的 node_modules 落到 `resources/node_modules`：任一环节失败即中止，
  // 绝不留下半成品资源。
  run([
    '--filter',
    './packages/*',
    '--filter',
    '!dsh-tauri-bundle',
    '--filter',
    '!dsh-tauri-tsdown',
    '-r',
    'run',
    'build',
  ])

  // pnpm v10 的 deploy 默认命中「legacy」算法：把产物链接到全局共享存储，导致部署出
  // 来的 node_modules 混入整个 workspace 的生产依赖（桌面壳的 React/UI 栈全部冗余）。
  // 改为现代「注入式」deploy（`--config.inject-workspace-packages=true`），只把 bundle 的
  // workspace 依赖及其真实生产闭包注入产物，得到紧凑可移植的 node_modules。
  // 但注入式默认仍是 isolated 布局：第三方依赖收进 `.pnpm/<dep>@<ver>/` 虚拟仓库，
  // 各插件靠虚拟仓库条目内的同级链接解析。materializeTree 把顶层插件符号链接解引用成
  // 实体目录时会丢掉这些同级依赖链接，产物里插件 `dist/index.js` 的裸 import（pathe /
  // unstorage 等）随之解析失败。改用 hoisted 布局（`--config.node-linker=hoisted`）让依赖
  // 平铺到顶层 node_modules，产物即自包含可解析，也彻底绕开符号链接。
  // 目标必须是空目录（src-tauri/resources 内含下发清单，不能直接部署）且为相对路径，
  // 因此先部署到仓库内相对临时目录，再把自包含的 node_modules 落入 resources/node_modules。
  const deployTarget = '.build-plugins-tmp'
  const temp = join(REPO_ROOT, deployTarget)
  rmSync(temp, { recursive: true, force: true })
  rmSync(DEPLOYED_NODE_MODULES, { recursive: true, force: true })
  try {
    run([
      '--filter',
      'dsh-tauri-bundle',
      'deploy',
      '--prod',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      deployTarget,
    ])
    const deployed = join(temp, 'node_modules')
    if (!existsSync(deployed)) {
      throw new Error(`PLUGIN_DEPLOY_EMPTY: pnpm deploy did not produce node_modules at ${deployed}`)
    }
    materializeTree(deployed, DEPLOYED_NODE_MODULES)
    verifyMaterialized(DEPLOYED_NODE_MODULES)
    verifyDeployedPackages(names, DEPLOYED_NODE_MODULES)
    console.log(`[build:plugins] deployed ${names.length} plugins to ${RESOURCE_ROOT}`)
  }
  catch (error) {
    // 部署失败则清理半成品，避免残留误导；成功时保留供 Tauri 打包。
    rmSync(DEPLOYED_NODE_MODULES, { recursive: true, force: true })
    throw error
  }
  finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

try {
  main()
}
catch (error) {
  console.error(`[build:plugins] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
