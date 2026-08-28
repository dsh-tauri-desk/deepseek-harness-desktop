import { appendFileSync, existsSync } from 'node:fs'
import process from 'node:process'
import { defineCommand, runCommand } from 'citty'
import { consola } from 'consola'
import { config as loadDotenv } from 'dotenv'
import { join, resolve } from 'pathe'
import { x } from 'tinyexec'
import { detectLocale, translate } from './predev.i18n'

// ==========================================
// 1. 配置与初始化
// ==========================================
const REPO_ROOT = resolve(import.meta.dirname, '..')
const ENV_FILE = join(REPO_ROOT, '.env')
const SUBMODULE_DIR = 'source/dsh-tauri-plugins' // 修正拼写: soruce -> source
const PLUGINS_DIR = `${SUBMODULE_DIR}/packages`
const SUBMODULE_PATH = join(REPO_ROOT, SUBMODULE_DIR)
const SUBMODULE_URL = 'https://github.com/dsh-tauri-desk/dsh-tauri-plugins.git'
const ENV_KEY = 'DEV_INTERNAL_PLUGINS_DIR'

// 加载 .env 变量到 process.env
loadDotenv({ path: ENV_FILE, quiet: true })

// 智能识别语言设置
const rawArgs = process.argv.slice(2)
const langArg = rawArgs.find(arg => arg.startsWith('--lang='))?.slice(7)
  ?? (rawArgs.includes('--lang') ? rawArgs[rawArgs.indexOf('--lang') + 1] : undefined)

let locale = detectLocale(langArg)

// ==========================================
// 2. 核心函数 (仅保留 2 个)
// ==========================================

/**
 * 命令执行器 (兼顾普通执行与输出捕获)
 */
async function exec(program: string, args: readonly string[], cwd = REPO_ROOT, capture = false): Promise<string> {
  if (!capture)
    consola.info(`$ ${program} ${args.join(' ')}`)
  const result = await x(program, args, {
    throwOnError: true,
    nodeOptions: { cwd, env: process.env, stdio: capture ? undefined : 'inherit' },
  })
  return capture ? result.stdout.trim() : ''
}

/**
 * 确保插件目录与环境配置就绪
 */
async function ensureInternalPlugins(skipPrompt: boolean): Promise<void> {
  // 1. Git 子模块检查与同步
  if (existsSync(join(SUBMODULE_PATH, '.git'))) {
    consola.start(translate(locale, 'git.checking', { dir: SUBMODULE_DIR }))
    await exec('git', ['fetch', '--quiet'], SUBMODULE_PATH)

    const [localRev, upstreamRev] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], SUBMODULE_PATH, true),
      exec('git', ['rev-parse', '@{upstream}'], SUBMODULE_PATH, true),
    ])

    if (localRev === upstreamRev) {
      consola.success(translate(locale, 'git.latest'))
    }
    else {
      await exec('git', ['pull', '--ff-only'], SUBMODULE_PATH)
      consola.success(translate(locale, 'git.updated'))
    }
  }

  // 2. 环境变量检测与快捷设置
  if (process.env[ENV_KEY]?.trim())
    return

  const confirm = skipPrompt || await consola.prompt(
    translate(locale, 'plugin.confirm'),
    { type: 'confirm', initial: false, cancel: 'reject' },
  )
  if (!confirm)
    return

  // 3. 克隆/校验子模块
  if (!existsSync(SUBMODULE_PATH)) {
    await exec('git', ['submodule', 'add', '-f', SUBMODULE_URL, SUBMODULE_DIR])
  }
  else if (!existsSync(join(SUBMODULE_PATH, '.git'))) {
    throw new Error(translate(locale, 'plugin.invalid_dir', { dir: SUBMODULE_DIR }))
  }
  else {
    consola.info(translate(locale, 'plugin.exists', { dir: SUBMODULE_DIR }))
  }

  // 4. 利用 dotenv 协作写回环境配置
  const separator = existsSync(ENV_FILE) ? '\n' : ''
  appendFileSync(ENV_FILE, `${separator}${ENV_KEY}=${PLUGINS_DIR}\n`, 'utf8')
  process.env[ENV_KEY] = PLUGINS_DIR
  consola.success(translate(locale, 'env.configured', { dir: PLUGINS_DIR }))
}

// ==========================================
// 3. CLI 主流程
// ==========================================

const command = defineCommand({
  meta: {
    name: 'predev',
    description: translate(locale, 'command.description'),
  },
  args: {
    yes: { type: 'boolean', description: translate(locale, 'command.yes') },
    lang: { type: 'enum', options: ['en-US', 'zh-CN'], description: translate(locale, 'command.lang') },
  },
  async run({ args, rawArgs }) {
    locale = detectLocale(args.lang)

    const isDev = rawArgs[0] === 'dev'
    // 剔除内部预处理参数
    const tauriArgs = isDev
      ? rawArgs.filter((arg, i) => arg !== '--yes' && arg !== '--lang' && !arg.startsWith('--lang=') && rawArgs[i - 1] !== '--lang')
      : rawArgs

    if (isDev) {
      await ensureInternalPlugins(args.yes === true)
    }

    await exec('tauri', tauriArgs)
  },
})

runCommand(command, { rawArgs }).catch((err: unknown) => {
  consola.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
