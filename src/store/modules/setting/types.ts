/**
 * 桌面端设置中**前端关心**的子集（字段名与 Rust `config::Setting` 一致，snake_case 直通）。
 *
 * 只镜像外壳真正消费的字段：档案、核心、桌宠、迁移标记等各有专用命令与查询，
 * 一并塞进来只会制造第二份真相。
 */
export interface AppSetting {
  /** 依赖是否已安装（boot 流程据此决定是否走安装与更新检查） */
  installed: boolean
  port: number
  auto_start: boolean
  cli_link_enabled: boolean
  zoom_factor: number
  close_action: string
  backup_retention_count: number
  backup_include_credentials: boolean
}

/**
 * `update_app_config` 的可写字段（camelCase，与 Rust 命令参数一一对应）。
 *
 * 语义是「部分更新」：未传的字段由后端保持原值。
 */
export interface AppSettingUpdate {
  port?: number
  autoStart?: boolean
  cliLinkEnabled?: boolean
  closeAction?: string
  backupRetentionCount?: number
  backupIncludeCredentials?: boolean
}
