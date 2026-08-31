import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
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
      deployTarget,
    ])
    const deployed = join(temp, 'node_modules')
    if (!existsSync(deployed)) {
      throw new Error(`PLUGIN_DEPLOY_EMPTY: pnpm deploy did not produce node_modules at ${deployed}`)
    }
    cpSync(deployed, DEPLOYED_NODE_MODULES, { recursive: true, dereference: true })
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
