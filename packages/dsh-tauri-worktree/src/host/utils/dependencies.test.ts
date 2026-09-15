import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isDependencyInstallCommand,
  linkWorktreeDependencies,
  normalizeLinkDirectories,
  unlinkWorktreeDependencies,
} from './dependencies'

const temporaryDirectories: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  return root
}

async function createFixture(): Promise<{ project: string, worktree: string, marker: string }> {
  const project = await temporaryRoot('dsh-deps-project-')
  const worktree = await temporaryRoot('dsh-deps-worktree-')
  const marker = join(project, 'node_modules', 'pkg', 'index.js')
  await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(marker, 'shared-dependency\n')
  return { project, worktree, marker }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('normalizeLinkDirectories', () => {
  it('falls back to node_modules for empty input and dedupes preserving order', () => {
    expect(normalizeLinkDirectories()).toEqual(['node_modules'])
    expect(normalizeLinkDirectories([])).toEqual(['node_modules'])
    expect(normalizeLinkDirectories(['.venv', 'node_modules', '.venv'])).toEqual(['.venv', 'node_modules'])
  })

  it('rejects path traversal and separator-bearing entries', () => {
    expect(normalizeLinkDirectories(['../evil', 'a/b', 'a\\b', '.', '..', '', '  '])).toEqual([])
    expect(normalizeLinkDirectories(['node_modules/'])).toEqual(['node_modules'])
  })
})

describe('isDependencyInstallCommand', () => {
  it.each([
    'pnpm install',
    'pnpm i',
    'pnpm add lodash',
    'npm ci',
    'npm install --frozen-lockfile',
    'yarn',
    'yarn add react',
    'bun install',
    'cd packages/app && pnpm install',
    'pip install -r requirements.txt',
    'uv sync',
    'cargo build',
    'go mod download',
    'bundle install',
    'composer install',
  ])('detects %s', (command) => {
    expect(isDependencyInstallCommand(command)).toBe(true)
  })

  it.each([
    '',
    'pnpm run build',
    'npm test',
    'pnpm exec tsc --noEmit',
    'git status',
    'npm run lint --fix',
    'node scripts/build.js',
  ])('ignores %s', (command) => {
    expect(isDependencyInstallCommand(command)).toBe(false)
  })
})

describe('linkWorktreeDependencies', () => {
  it('links the source dependency directory into the worktree and reads through it', async () => {
    const { project, worktree } = await createFixture()
    const result = await linkWorktreeDependencies(project, worktree, ['node_modules'])

    expect(result.linked).toEqual(['node_modules'])
    const stats = await lstat(join(worktree, 'node_modules'))
    expect(stats.isSymbolicLink()).toBe(true)
    expect(await readFile(join(worktree, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('shared-dependency\n')
  })

  it('skips missing source directories and already-populated targets', async () => {
    const project = await temporaryRoot('dsh-deps-project-')
    const worktree = await temporaryRoot('dsh-deps-worktree-')
    await mkdir(join(worktree, 'node_modules'), { recursive: true })

    const missingSource = await linkWorktreeDependencies(project, worktree, ['node_modules'])
    expect(missingSource).toEqual({ linked: [], skipped: ['node_modules'] })

    const { project: withSource, worktree: emptyWorktree } = await createFixture()
    await mkdir(join(emptyWorktree, 'node_modules'), { recursive: true })
    const occupiedTarget = await linkWorktreeDependencies(withSource, emptyWorktree, ['node_modules'])
    expect(occupiedTarget).toEqual({ linked: [], skipped: ['node_modules'] })
  })
})

describe('unlinkWorktreeDependencies', () => {
  it('removes only the link and keeps the source dependency tree intact', async () => {
    const { project, worktree, marker } = await createFixture()
    await linkWorktreeDependencies(project, worktree, ['node_modules'])

    await expect(unlinkWorktreeDependencies(worktree, ['node_modules'])).resolves.toEqual(['node_modules'])
    await expect(lstat(join(worktree, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(marker, 'utf8')).toBe('shared-dependency\n')
  })

  it('leaves a real (independently installed) directory untouched', async () => {
    const worktree = await temporaryRoot('dsh-deps-worktree-')
    const installed = join(worktree, 'node_modules', 'pkg')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'index.js'), 'independent\n')

    await expect(unlinkWorktreeDependencies(worktree, ['node_modules'])).resolves.toEqual([])
    expect(await readFile(join(installed, 'index.js'), 'utf8')).toBe('independent\n')
  })

  it('is idempotent when the directory is absent', async () => {
    const worktree = await temporaryRoot('dsh-deps-worktree-')
    await expect(unlinkWorktreeDependencies(worktree, ['node_modules'])).resolves.toEqual([])
  })
})
