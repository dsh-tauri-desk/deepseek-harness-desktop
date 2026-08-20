import type { UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'

/** Rust 侧 service::plugin::watch::DshPlugin 的序列化形态（camelCase） */
export interface DshPlugin {
  /** 依赖键（npm 包名），列表主键 */
  id: string
  /** 展示名：插件自身 package.json 的 name，缺失时回落预设清单 */
  name: string
  /** 已安装版本（解析失败时为空字符串） */
  version: string
  description: string
  /** 仓库地址（repository.url / homepage） */
  repo_url: string
  /** 是否在 dsh.profile.bundles 中（启动时自动加载） */
  bundled: boolean
  /** 是否允许从启动冲突恢复流程移除（核心 Bundle 为 false） */
  removable: boolean
  /** 预设清单中的「推荐」标记 */
  recommended: boolean
  /** 预设清单中的「修复」标记 */
  fix: boolean
}

export interface UseDshPluginsResult {
  plugins: DshPlugin[]
  loading: boolean
  error: string
  /** 手动重新拉取（Rust 侧也会在插件文件变化时实时推送） */
  refresh: () => Promise<void>
}

/**
 * 已安装 dsh 插件列表（实时同步）。
 *
 * 后端（`service/plugin/watch`）秒级监控 profile 插件文件（package.json +
 * node_modules 下各直接依赖清单），解析出插件元信息；首次加载走
 * `get_dsh_plugins` 命令，之后插件安装/卸载/升级时通过
 * `dsh-plugins-updated` 事件增量推送，无需轮询。
 */
export function useDshPlugins(): UseDshPluginsResult {
  const [plugins, setPlugins] = useState<DshPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let disposed = false

    function apply(list: DshPlugin[]) {
      if (disposed)
        return
      setPlugins(list)
      setLoading(false)
      setError('')
    }

    function fail(err: unknown) {
      if (disposed)
        return
      console.error('[useDshPlugins] failed to load plugins:', err)
      setError(String(err))
      setLoading(false)
    }

    // 先订阅事件再拉取初始值，避免两者之间的插件变化丢失
    listen<DshPlugin[]>('dsh-plugins-updated', (event) => {
      apply(event.payload)
    }).then((fn) => {
      if (disposed)
        fn()
      else
        unlisten = fn
    }).catch((err) => {
      console.error('[useDshPlugins] failed to listen dsh-plugins-updated:', err)
    })

    invoke<DshPlugin[]>('get_dsh_plugins').then(apply).catch(fail)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  async function refresh() {
    setLoading(true)
    try {
      const list = await invoke<DshPlugin[]>('get_dsh_plugins')
      setPlugins(list)
      setError('')
    }
    catch (err) {
      console.error('[useDshPlugins] refresh failed:', err)
      setError(String(err))
    }
    finally {
      setLoading(false)
    }
  }

  return { plugins, loading, error, refresh }
}
