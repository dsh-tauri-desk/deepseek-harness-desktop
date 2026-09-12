/** Rust 侧 service::plugin::watch::PluginErrorInfo 的序列化形态（camelCase） */
export interface PluginErrorInfo {
  /** 错误消息（pnpm/运行日志片段） */
  message: string
  /** 记录动作：install / update / remove / runtime */
  action: string
  /** 记录时间（unix 秒级时间戳字符串） */
  at: string
}

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
  /** 是否在禁用清单（disabled-plugins.json）中，独立于 bundled */
  disabled: boolean
  /** 是否在 cordis.patch.yml 中被配置覆盖禁用（disabled: true），优先级高于禁用清单 */
  patchDisabled: boolean
  /** 预设清单中的「推荐」标记 */
  recommended: boolean
  /** 预设清单中的「修复」标记 */
  fix: boolean
  /** 预设清单中的「内置」标记（随包分发/本地热更新）：隐藏卸载入口并标注 [内置] */
  internal: boolean
  /** 是否有可用更新（由 `service::plugin::updates` 探测；未判定时为 false） */
  updateAvailable: boolean
  /** 判定得到的「最新版本」（registry latest / git HEAD SHA）；未判定时缺省 */
  latestVersion?: string
  /** 是否有单插件快照（$DSH_HOME/.plugin-backups/<id>.tgz），决定还原/删除快照入口 */
  hasSnapshot: boolean
  /** 异常信息（安装/升级/卸载失败或页面运行期上报）；undefined = 正常 */
  error?: PluginErrorInfo | null
}
