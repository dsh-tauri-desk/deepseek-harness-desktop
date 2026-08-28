//! 信任模式（Trust Mode）：读写 Harness 的权限预设，免除逐次执行审批。
//!
//! 落盘与判定逻辑在 [`crate::service::workflow::trust_mode`]；本模块只做命令出口。
//! 两个命令都走 `spawn_blocking`——`settings.yaml` 由 harness 进程共享读写，
//! 同步 IO 不应占用异步运行时。

/// 信任模式是否已开启。
///
/// 即 `$DSH_HOME/settings.yaml` 的 `permissionPresets.defaultPreset` 是否为
/// `danger-full-access`（沙箱非受限 + 审批策略 `never`）。文件缺失时按 harness
/// 默认行为（逐次询问）返回 `false`。
#[tauri::command]
pub async fn get_trust_mode(app: tauri::AppHandle) -> bool {
    tokio::task::spawn_blocking(move || {
        crate::service::workflow::trust_mode::trust_mode_enabled(&app)
    })
    .await
    .unwrap_or(false)
}

/// 开启/关闭信任模式：在 `danger-full-access` 与 `workspace-write` 之间切换默认预设。
///
/// 幂等。变更对**之后新建的会话**生效——会话创建时即固定其权限，既有会话不会
/// 被追溯改写，因此前端需要提示用户「新开一个会话」而非「重启服务」。
#[tauri::command]
pub async fn set_trust_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::service::workflow::trust_mode::set_trust_mode(&app, enabled)
    })
    .await
    .unwrap_or_else(|e| Err(format!("TRUST_MODE_TASK: {e}")))
}
