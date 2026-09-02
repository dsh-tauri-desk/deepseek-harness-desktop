//! 单插件升级/卸载：`dsh plugin --profile <当前档案> update/remove <id>`。
//! 与安装共用环境准备（shim、pnpm 选版、停止服务）与 allowBuilds 重试；
//! 卸载后核验 profile 清单，插件仍被引用时走离线卸载兜底（受保护包除外）。
//! 另含启动期弃用插件自动卸载（`uninstall_deprecated_plugins`）。

use std::collections::HashSet;
use std::ffi::OsString;
use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::profile::active_profile;
use crate::service::workflow;

use super::artifact::{ensure_plugin_entry_built, installed_package_name};
use super::build_plugin_envs;
use super::diagnose::{git_transport_hint, network_error_hint, pick_error_message};
use super::errors;
use super::installed_name;
use super::is_actionable_plugin_ref;
use super::is_installed;
use super::load_deprecated_ids;
use super::load_presets;
use super::new_process_owner;
use super::pnpm::ensure_pnpm;
use super::profile_dir;
use super::run_plugin_with_allow_build_retry;
use super::uninstall_recovery;
use super::PreinstallPluginInfo;
use super::{PreinstallLogPayload, PREINSTALL_LOG_EVENT};

pub async fn update(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    run_single_plugin_command(
        app_handle,
        id,
        "update",
        &["update".to_string(), id.to_string()],
    )
    .await
}

/// 卸载单个插件：`dsh plugin --profile <当前档案> remove <id>`
pub async fn remove(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let command_result = run_single_plugin_command(
        app_handle,
        id,
        "remove",
        &["remove".to_string(), id.to_string()],
    )
    .await;
    // `dsh plugin remove` 以子进程退出码为准，可能出现「命令成功但插件仍在」的
    // 边界（如 bundle 层残留、pnpm 静默失败）；node_modules / lockfile 损坏时
    // （典型：安装只写入了 profile 清单而产物缺失，见 issue #90）pnpm 甚至会
    // 直接失败。两种情形统一核验 profile 清单：只要插件仍被引用就回落离线卸载
    // （直接改清单 + 删目录 + 清 lockfile），确保插件真正移除
    // （参考 dsh-market 的「卸载后核验」约定：确认插件离开 profile 才算成功）。
    if is_installed(app_handle, id) {
        // 第三方可卸载插件才允许离线兜底；核心/官方等受保护包即使残留也不强删
        // （`uninstall_recovery` 对它们会拒绝）。
        if is_actionable_plugin_ref(id) {
            let outcome = match &command_result {
                Ok(()) => "reported success".to_string(),
                Err(e) => format!("failed: {e}"),
            };
            log::warn!(
                "dsh plugin remove {outcome} but {id} is still referenced by profile manifest; forcing offline uninstall"
            );
            uninstall_recovery(app_handle, id)?;
            // 离线兜底成功：插件已真正从 profile 移除，清除历史错误，避免前端
            // 残留异常标记（best-effort）。
            if let Err(e) = errors::clear(app_handle, id) {
                log::warn!("failed to clear plugin error for {id}: {e}");
            }
        } else {
            // 受保护包：命令失败则如实上报（不要把失败误报为成功），成功则仅告警。
            command_result?;
            log::warn!(
                "dsh plugin remove reported success but protected package {id} is still referenced by profile manifest; skipping offline uninstall"
            );
        }
    }
    // 卸载级联清理单插件快照（best-effort）：插件已移除，快照随之失效
    // （issue #303：卸载后删除快照，避免残留孤儿快照占用存储）。
    super::super::snapshot::delete_best_effort(app_handle, id);
    Ok(())
}

/// 计算需要自动卸载的弃用插件已安装包名（纯函数，便于单测）。
///
/// 命中条件：id 登记在弃用清单（`resources/deprecated-plugins.json`，见
/// [`super::super::preset::load_deprecated_ids`]）、非内部插件（内部插件由启动
/// 自愈强制安装，不适用弃用语义），且当前已安装（以实际 npm 包名 `installed_name`
/// 为准）。返回实际安装包名——离线卸载（`uninstall_recovery`）以它为键从 profile
/// 清单与 `node_modules` 精准移除（scoped 包名与预设 id 不一致时也能正确卸载）。
fn deprecated_installed_names(
    presets: &[PreinstallPluginInfo],
    deprecated_ids: &HashSet<String>,
    installed: impl Fn(&str) -> bool,
) -> Vec<String> {
    presets
        .iter()
        .filter(|p| deprecated_ids.contains(&p.id) && !p.internal)
        .filter(|p| installed(installed_name(p)))
        .map(|p| installed_name(p).to_string())
        .collect()
}

/// 启动时自动卸载弃用清单（`resources/deprecated-plugins.json`）登记的插件。
///
/// 弃用是发布侧决策：某个社区插件下架/被替换后，把它的 id 追加进弃用清单，桌面端
/// 每次启动核对「已安装 → 自动卸载」，无需用户手动处理，也避免残留插件继续在
/// profile 里加载破坏启动。仅处理社区预设；未被引用的条目跳过。已卸载/未安装的
/// 插件跳过，绝不误伤其它插件。
///
/// 启动阶段走离线精准卸载（`uninstall_recovery`）：不依赖 node/pnpm/窗口，即使
/// 插件产物已损坏也能移除，也不会触发服务停止或 pnpm 下载。最佳努力：任何失败
/// 只记告警，不阻断启动（调用方仅打日志）。
pub(crate) async fn uninstall_deprecated_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    let deprecated_ids = load_deprecated_ids(app_handle);
    let names = deprecated_installed_names(&presets, &deprecated_ids, |name| {
        is_installed(app_handle, name)
    });
    if names.is_empty() {
        return Ok(());
    }
    log::info!("uninstalling deprecated preset plugins: {names:?}");
    let mut failures = Vec::new();
    for name in &names {
        log::info!("DEPRECATED_PLUGIN_UNINSTALL: removing deprecated plugin {name}");
        if let Err(e) = uninstall_recovery(app_handle, name) {
            log::warn!("DEPRECATED_PLUGIN_UNINSTALL_FAILED: {name}: {e}");
            failures.push(format!("{name}: {e}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "DEPRECATED_PLUGIN_UNINSTALL_FAILED: {}",
            failures.join("; ")
        ))
    }
}

/// 执行单个插件的升级/卸载：准备环境 → 停止服务 → 运行 `dsh plugin` →
/// 失败记录错误、成功清除错误。
async fn run_single_plugin_command(
    app_handle: &AppHandle,
    id: &str,
    action: &str,
    sub_args: &[String],
) -> Result<(), String> {
    if id.is_empty() {
        return Err("PLUGIN_EMPTY_ID: plugin id is empty".to_string());
    }
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    cli::ensure_shims(app_handle)?;

    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = core::active_dsh_binary(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let owner = new_process_owner();
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window, owner).await?;
    // `.npmrc` 可能在服务启动后被删除；升级/卸载同样可能触发 pnpm 非交互清理。
    super::ensure_profile_npmrc(app_handle)?;
    // 与批量安装保持一致：旧档案也必须具备精确的 release-age 例外，
    // 否则升级/卸载触发 pnpm lockfile 校验时同样会被 issue #222 的问题阻断。
    super::ensure_profile_pnpm_policy(app_handle)?;
    // 插件操作会改写 profile，先停止运行中的服务（与安装一致）
    if workflow::has_owned_process() {
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!("[harness] 正在停止运行中的服务（{action}插件需要短暂重启）…"),
            },
        );
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before plugin {action}: {e}");
        }
    }
    // 升级前自动快照当前版本（覆盖式），失败仅告警不阻断升级。
    // 必须在停服之后执行：服务运行期间插件目录可能被写入，先停服保证快照一致
    // （issue #303：自动快照失败不阻塞主流程；还原入口在插件面板）。
    if action == "update" {
        super::super::snapshot::create_best_effort(app_handle, id);
    }

    let envs = build_plugin_envs(app_handle, prefer_bundled_pnpm);

    let mut args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(active_profile(app_handle)),
        OsString::from(action),
    ];
    args.extend(sub_args.iter().map(OsString::from));

    let cwd = config::get_dsh_install_path(app_handle);
    log::info!("Running dsh plugin {action} for {id}");
    let (exit_code, output) = run_plugin_with_allow_build_retry(
        app_handle, &node, &args, &cwd, &envs, &window, action, None, owner,
    )
    .await?;

    if exit_code != 0 {
        log::error!("dsh plugin {action} failed for {id} with exit code {exit_code}");
        let network_error =
            network_error_hint(&output).is_some() || (exit_code == 3 && output.trim().is_empty());
        let message = if network_error {
            "NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry."
                .to_string()
        } else {
            pick_error_message(&output, git_transport_hint(&output))
        };
        if let Err(e) = errors::record(app_handle, id, action, &message) {
            log::warn!("failed to record plugin error for {id}: {e}");
        }
        if network_error {
            return Err("NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.".to_string());
        }
        return Err(format!(
            "PLUGIN_{}_FAILED: dsh plugin exited with code {exit_code}",
            action.to_uppercase()
        ));
    }

    // 成功：清除历史错误；卸载 win-terminal-inspector 时顺带清理 patch 挂载
    if let Err(e) = errors::clear(app_handle, id) {
        log::warn!("failed to clear plugin error for {id}: {e}");
    }
    // 升级路径与安装一致地核验构建产物：git 托管插件升级后同样可能停在
    // 「prepare 未构建 → 声明入口缺失」坏态，若不拦截，下一次启动即崩溃
    // （见 [`ensure_plugin_entry_built`]）。包名先解析（预设 package 覆盖 /
    // 清单依赖 basename），解析不到时跳过核验（警告即可，不误杀成功更新）。
    if action == "update" {
        let Some(name) = installed_package_name(app_handle, id) else {
            log::warn!("plugin {id} not resolvable to a package name, skipping entry verify");
            return Ok(());
        };
        let pkg_dir = profile_dir(app_handle).join("node_modules").join(name);
        if let Err(e) = ensure_plugin_entry_built(app_handle, id, &pkg_dir, &envs, &window).await {
            if let Err(err) = errors::record(app_handle, id, action, &e) {
                log::warn!("failed to record plugin error for {id}: {err}");
            }
            return Err(e);
        }
    }
    if action == "remove" && id == "dsh-win-terminal-inspector" {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector patch prune failed after remove: {e}");
        }
    }
    log::info!("dsh plugin {action} succeeded for {id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str, spec: &str, internal: bool) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: spec.into(),
            package: None,
            name: String::new(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            win_only: false,
            internal,
        }
    }

    #[test]
    fn deprecated_installed_only_picks_marked_and_installed() {
        // 弃用清单只登记 dsh-ok / dsh-scoped / dsh-not-installed 三个 id；
        // 只把 `dsh-ok` 视为已安装，其余一律未安装（便于区分「登记但未安装」）。
        let deprecated: HashSet<String> = ["dsh-ok", "dsh-scoped", "dsh-not-installed"]
            .into_iter()
            .map(String::from)
            .collect();
        let installed = |name: &str| matches!(name, "dsh-ok" | "@scope/deprecated");

        // 命中：登记且已安装 → 返回实际安装包名（dsh-ok 未声明 package，回落 id）
        assert_eq!(
            deprecated_installed_names(
                &[preset("dsh-ok", "dshmarket", false)],
                &deprecated,
                installed
            ),
            vec!["dsh-ok".to_string()]
        );

        // scoped 包：返回真实安装包名（与预设 id 不一致）
        let mut scoped = preset("dsh-scoped", "github:x/y", false);
        scoped.package = Some("@scope/deprecated".into());
        assert_eq!(
            deprecated_installed_names(&[scoped], &deprecated, installed),
            vec!["@scope/deprecated".to_string()]
        );

        // 未登记弃用：即使已安装也不命中
        let plain = preset("dsh-plain", "dsh-plain", false);
        assert!(deprecated_installed_names(&[plain], &deprecated, installed).is_empty());

        // 登记了但未安装：不命中
        let absent = preset("dsh-not-installed", "dshmarket", false);
        assert!(deprecated_installed_names(&[absent], &deprecated, installed).is_empty());

        // 内部插件即使登记弃用也不命中（内部插件由启动自愈强制安装）
        let internal = preset("dsh-internal", "dsh-tauri@0.2.0", true);
        assert!(
            deprecated_installed_names(&[internal], &deprecated, |name| matches!(
                name,
                "dsh-internal"
            ))
            .is_empty()
        );
    }
}
