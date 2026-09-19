import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE_MANIFEST = new URL('../packages/dsh-tauri-bundle/package.json', import.meta.url)
const RESOURCE_NODE_MODULES = new URL('../src-tauri/resources/node_modules/', import.meta.url)
const DSH_STATIC_IMPORT = /\b(?:from|import)\s*['"]@deepseek-ai\/[^'"]+['"]|\brequire\s*\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/

/**
 * 部署产物 `src-tauri/resources/node_modules/` 由 `pnpm build:plugins` 生成，不随仓库提交。
 * 未构建时整组用例跳过——否则每次干净检出都会报「文件不存在」，把缺前置误报成缺陷。
 * CI 的 Plugins E2E job 会先构建，因此那一条链路下本组用例照常执行。
 */
const BUILT = existsSync(fileURLToPath(RESOURCE_NODE_MODULES))

interface PluginManifest {
  name?: unknown
  dependencies?: Record<string, unknown>
  dsh?: unknown
  main?: unknown
}

function readJson(url: URL | string): PluginManifest {
  return JSON.parse(readFileSync(url, 'utf8')) as PluginManifest
}

function bundledPluginNames(): string[] {
  return Object.keys(readJson(BUNDLE_MANIFEST).dependencies ?? {})
}

function packageJsonFiles(root: URL): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'package.json')
      files.push(join(entry.parentPath, entry.name))
  }
  return files
}

describe.skipIf(!BUILT)('bundled plugin resource closure', () => {
  it('contains every bundled plugin with a valid entry', () => {
    for (const name of bundledPluginNames()) {
      const manifestUrl = new URL(`../src-tauri/resources/node_modules/${name}/package.json`, import.meta.url)
      expect(() => readJson(manifestUrl)).not.toThrow()
      const manifest = readJson(manifestUrl)
      expect(typeof manifest.dsh === 'object' && manifest.dsh !== null && !Array.isArray(manifest.dsh)).toBe(true)
      if (typeof manifest.main === 'string')
        expect(statSync(new URL(`../src-tauri/resources/node_modules/${name}/${manifest.main}`, import.meta.url)).isFile()).toBe(true)
    }
  })

  it('does not ship build-only date-fns or any nested copy', () => {
    const dateFnsPackages = packageJsonFiles(RESOURCE_NODE_MODULES)
      .filter(file => readJson(pathToFileURL(file)).name === 'date-fns')

    expect(dateFnsPackages).toEqual([])
  })

  it('keeps DSH-owned host modules loader-resolved', () => {
    for (const name of bundledPluginNames()) {
      const manifestUrl = new URL(`../src-tauri/resources/node_modules/${name}/package.json`, import.meta.url)
      const manifest = readJson(manifestUrl)
      if (typeof manifest.main !== 'string')
        continue

      const entryUrl = new URL(`../src-tauri/resources/node_modules/${name}/${manifest.main}`, import.meta.url)
      expect(statSync(entryUrl).isFile()).toBe(true)
      expect(readFileSync(entryUrl, 'utf8')).not.toMatch(DSH_STATIC_IMPORT)
    }
  })
})
