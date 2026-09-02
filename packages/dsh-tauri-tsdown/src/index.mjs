import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** 是否处于 watch/dev 模式（dev:plugins → `tsdown --watch` 常驻）：跳过 minify 加速热重建。 */
const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w')

function clientBundleRegistration() {
  const packageName = process.env.npm_package_name
  const pkg = packageName
    ? { name: packageName }
    : JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const id = JSON.stringify(pkg.name)
  // Only the JS bundle is a runtime script wrapped in the ModuleLoader factory.
  // Declaration files must stay real ES modules (top-level import/export) —
  // wrapping them breaks types ("file is not a module") — so apply the wrapper
  // exclusively to JS outputs via the `{ js }` addon form.
  return {
    banner: {
      js: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{const loaderRequire=require;const resolve=(specifier)=>specifier.endsWith('/client')?specifier.slice(0,-7):specifier;require=(specifier)=>loaderRequire(resolve(specifier));var module={exports:{}};var exports=module.exports;`,
    },
    footer: {
      js: 'return module.exports;}});',
    },
  }
}

export const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'dsh-tauri/client',
  /^@deepseek-ai\//,
]

/**
 * 需要内联进 client bundle 的依赖（UnJS 工具库 + date-fns）。
 *
 * client bundle 在 DSH Web ModuleLoader（dsh-client-modules）的 factory 里运行，
 * 其模块表只认识平台种子词（react / @deepseek-ai/*）与已加载的链接模块
 * （dsh-tauri/client）。tsdown 默认把 package.json 的 `dependencies` 当 external，
 * 若这些包在 client 代码里被直接 import，产物会发出 loader 的
 * `require('hookable')` 之类调用——模块表查不到就报
 * "missed the module table"（build-time externals drift）。
 * 因此 client entry 必须把它们内联；host entry 保持 external（Node 运行时按
 * 插件 dependencies 解析）。子路径（unstorage/drivers/*）一并覆盖。
 * date-fns 是 client 侧时间格式化依赖（dsh-tauri-panel-scheduler），同样内联。
 */
const dshClientInline = [/^(unstorage|hookable|ofetch|pathe|date-fns)([/-].*)?$/]

export function defineDshConfig(options = {}) {
  const common = {
    outDir: 'dist',
    format: 'esm',
    outExtensions: () => ({ js: '.js' }),
    publint: options.publint ?? true,
    external: dshExternal,
  }

  return [
    {
      ...common,
      ...options.server,
      entry: { index: 'src/index.ts' },
      dts: true,
      sourcemap: false,
      clean: true,
    },
    {
      ...common,
      entry: { client: 'src/client/index.ts' },
      // Client bundles are classic scripts consumed by dsh-client-modules.
      // CJS output is required so its exports remain inside the loader factory.
      format: 'cjs',
      // UnJS 四库内联（模块表不认识的依赖不能留 require，见 dshClientInline 注释）。
      noExternal: dshClientInline,
      // CJS must not use `.js` in a `"type": "module"` package — publint would
      // flag the ESM/CJS mismatch. Emit `.cjs` (declarations pair as `.d.cts`).
      outExtensions: () => ({ js: '.cjs' }),
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      ...clientBundleRegistration(),
      // The client entry is deliberately a classic CJS script wrapped by ModuleLoader;
      // publint's ESM/CJS default-export heuristic is inapplicable.
      publint: false,
      dts: false,
      sourcemap: true,
      minify: !isWatchMode,
      clean: false,
      ...options.client,
    },
  ]
}

export { defineConfig } from 'tsdown'
