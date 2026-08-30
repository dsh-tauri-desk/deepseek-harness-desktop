//! 预装插件安装：校验选中项、准备环境（pnpm/dsh shim、按需补齐捆绑 pnpm、
//! 停止运行中的服务），随后调用 `dsh plugin --profile web add <specs...>`，
//! 成功后执行 Windows 极简模式专项修复。
//!
//! pnpm 对两类构建脚本默认不放行、缺白名单时报硬错误：
//! 1. git 托管插件的 `prepare` 构建（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）——
//!    其允许键随 pnpm 的克隆方式变化（git+ssh#sha / codeload tar.gz），无法预先确定；
//! 2. 传递依赖的原生构建（如 `node-pty`，`ERR_PNPM_IGNORED_BUILDS`）。
//! 因此从 pnpm 错误输出解析它建议的允许键，写入 profile 的
//! `pnpm-workspace.yaml` 后重试，直至成功或无可解析项。
//!
//! pnpm 10 与 11 对放行项的配置键与输出形式不同（均由各自报错提示决定，只能运行期
//! 读取，见 [`allowlist::parse_allowlist_keys`] 与 [`allowlist::apply_allow_build_keys`]）：
//! - pnpm 10（旧 store 复用用户版）只认 `onlyBuiltDependencies`（list 形式）；
//! - pnpm 11（捆绑版）认 `allowBuilds`（map 形式）。
//! 应用会把同一批包名同时写入这两个键，保证任一版本 pnpm 都能读到放行项。
//!
//! 关键陷阱：pnpm v11 在 `allowBuilds` 阻断时可能仍以 **exit 0** 退出（假成功），
//! 所以重试逻辑不能只看退出码（见 [`run_plugin_with_allow_build_retry`]），安装成功
//! 后还会核验 `node_modules` 产物是否真实落盘（见 [`artifact::verify_installed_products`]），
//! 并就地补构建缺失的声明入口（见 [`artifact::ensure_plugin_entry_built`]）。
//!
//! 模块划分（`install/`）：
//! - [`self`]：安装编排入口（install / install_internal）与 allowBuilds 重试循环
//! - [`single`]：单插件升级/卸载（`dsh plugin update/remove`，卸载后核验 + 离线兜底、
//!   弃用插件自动卸载）
//! - [`spec`]：安装 spec 准备（内置插件捆绑目录、GitHub 简写规范化、Windows 引号）
//! - [`env`]：`dsh plugin` 子进程环境（$DSH_HOME 隔离、git HTTPS 强制）
//! - [`pnpm`]：pnpm 选版与版本探测（store 主版本感知、捆绑版补齐、有界 probe 监控）
//! - [`allowlist`]：构建放行白名单解析与 pnpm-workspace.yaml 写回
//! - [`diagnose`]：失败输出解析（网络 / git 传输层 / ANSI 清洗与消息挑选）
//! - [`artifact`]：安装产物落盘核验（防「假成功」）+ 声明入口就地补构建

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::profile::active_profile;
use crate::service::workflow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

// plugin 兄弟模块的再导出：子模块经 `super::` 统一从这里取，跨模块边界只在此定义。
pub(crate) use super::ensure_profile_npmrc;
pub(crate) use super::errors;
pub(crate) use super::installed::{installed_name, is_installed, profile_dir};
pub(crate) use super::preset::{
    bundled_dep_spec, bundled_plugin_dir, load_deprecated_ids, load_presets, PreinstallPluginInfo,
};
pub(crate) use super::process::{
    acquire_operation_lock, acquire_process_lock, new_process_owner, run_plugin_process, PidGuard,
    PreinstallLogPayload, ProcessOwner, PREINSTALL_LOG_EVENT,
};
pub(crate) use super::recovery::is_actionable_plugin_ref;
pub(crate) use super::uninstall_recovery;
pub(crate) use crate::service::profile::ensure_profile_pnpm_policy;

mod allowlist;
mod artifact;
mod diagnose;
mod env;
mod pnpm;
mod single;
mod spec;

// 子模块对外 API：plugin 兄弟模块（verify / internal 等）与安装编排共用
pub(crate) use env::build_plugin_envs;
pub(crate) use pnpm::{
    bundled_pnpm_major, harness_prefer_bundled_pnpm, pnpm_major_version_at, profile_store_major,
};
pub(crate) use single::uninstall_deprecated_plugins;
pub use single::{remove, update};

use allowlist::{add_allow_build_keys, parse_allowlist_keys};
use artifact::{ensure_plugin_entry_built, verify_installed_products};
use diagnose::{diagnostic_suffix, git_transport_hint, network_error_hint, pick_error_message};
use pnpm::ensure_pnpm;
use spec::{bundled_dir_of, normalize_git_spec, preset_spec_for_install, shell_quote_spec};

/// 允许构建重试的上限。每次重试解决 pnpm 报出的一个允许键（git depPath 或
/// 传递构建包名），多个 git 插件 / 多个原生依赖各占一次，上限封顶防死循环。
const MAX_ALLOW_LIST_RETRIES: usize = 8;

pub async fn install(app_handle: &AppHandle, ids: &[String]) -> Result<(), String> {
    install_with_cancel(app_handle, ids, None, new_process_owner()).await
}

/// 内置插件启动自愈专用入口：取消信号会阻止被结束的 pnpm/dsh 进程再次进入
/// allowBuilds 重试，确保硬上限之后不会悄悄拉起下一棵进程树。
pub(crate) async fn install_internal(
    app_handle: &AppHandle,
    ids: &[String],
    cancel: tokio::sync::watch::Receiver<bool>,
    owner: ProcessOwner,
) -> Result<(), String> {
    install_with_cancel(app_handle, ids, Some(cancel), owner).await
}

async fn install_with_cancel(
    app_handle: &AppHandle,
    ids: &[String],
    cancel: Option<tokio::sync::watch::Receiver<bool>>,
    owner: ProcessOwner,
) -> Result<(), String> {
    if ids.is_empty() {
        return Err("PREINSTALL_EMPTY: no plugins selected".to_string());
    }

    // 单次读取预设并构建查找表，提升算法效率至 O(N)
    let presets = load_presets(app_handle);
    let preset_map: HashMap<&str, &PreinstallPluginInfo> =
        presets.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut specs = Vec::with_capacity(ids.len());
    for id in ids {
        let preset = preset_map
            .get(id.as_str())
            .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
        // 内置插件改为从随包分发的捆绑目录安装（`link:` 本地联接依赖，见
        // preset::bundled_dep_spec；不用 `file:`——pnpm 对盘符冒号的绝对路径
        // 会当相对路径解析），其余沿用清单声明的 spec；随后统一把
        // `github:user/repo` 规范为显式 `git+https://...`，绕开 pnpm 对
        // GitHub 简写「HTTPS 探测失败即回退 SSH」的已知缺陷（pnpm issue
        // #3948 / #7243 / #13276）：公开仓库一旦落进 git+ssh，在没有 SSH 配置
        // 的桌面机上必然 `Host key verification failed` / `Permission denied (publickey)`。
        //
        // 最后经 shell_quote_spec 给含空格的 spec 加内嵌双引号（**仅 Windows**）：
        // dsh CLI 只在 win32 用 `shell:true` 启动 pnpm、把参数按空格拼接（Node
        // 不引号转义，DEP0190），内置插件指向应用安装目录（如
        // `G:\Deepseek Harness Desktop\...`，路径常含空格），拼进 shell 后会被
        // 切碎成多个 spec，pnpm 报 `ERR_PNPM_SPEC_NOT_SUPPORTED`，插件装不上、
        // 启动自愈每次重装（死循环）。引号让 cmd 把整条 spec 视为单一 token；
        // pnpm 解析后自行剥离引号，落盘值仍是不带引号的 `link:<路径>`，与内核
        // 对账的 `expected`（bundled_dep_spec）一致。macOS/Linux 是直接
        // `spawnSync`（无 shell），spec 作为单个 argv 传递、空格天然保留，
        // 引号只会被当作包名字符导致安装失败（见 [`shell_quote_spec`]）。
        let raw = normalize_git_spec(&preset_spec_for_install(
            preset,
            bundled_dir_of(app_handle, preset),
        )?);
        specs.push(shell_quote_spec(&raw));
    }

    // 确保 pnpm/dsh shim 存在
    cli::ensure_shims(app_handle)?;

    let node = config::get_node_binary_path(app_handle);
    // 活动核心的 dsh 入口：本地核心存在时用本地 CLI，否则预打包
    let dsh_bin = core::active_dsh_binary(app_handle);
    if !node.exists() {
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    // 选定/补齐安装用的 pnpm：返回是否应强制使用捆绑版（版本感知，见 ensure_pnpm）
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window, owner).await?;
    // 首次安装可能早于服务启动；提前写入非交互清理配置，避免 pnpm 在无 TTY
    // 环境以 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY 中止（issue #130）。
    super::ensure_profile_npmrc(app_handle)?;
    // 旧档案可能由早期版本创建，没有同步 Harness 的最小发布时间例外；补齐
    // 精确的已审查 zod 版本，避免 registry 元数据瞬时失败阻断插件安装（issue #222）。
    super::ensure_profile_pnpm_policy(app_handle)?;

    // 安装前停止运行中的服务，避免资源冲突
    if workflow::has_owned_process() {
        // 停服务会让用户感到"重启"，先在日志面板讲清缘由（issue #48）
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: "[harness] 正在停止运行中的服务（安装插件需要短暂重启）…".to_string(),
            },
        );
        log::info!("Stopping running harness service before installing plugins");
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before plugin install: {e}");
        }
    }

    let envs = build_plugin_envs(app_handle, prefer_bundled_pnpm);

    // 拼装命令行参数
    let mut args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(active_profile(app_handle)),
        OsString::from("add"),
    ];
    args.extend(specs.iter().map(|s| OsString::from(s.as_str())));

    let cwd = config::get_dsh_install_path(app_handle);
    // 日志打印实际传给 dsh 的 spec（此前打印 id 会误导排查：安装用的是 spec）
    log::info!("Running dsh plugin install for {specs:?}");

    // `dsh plugin add` 在 profile 目录里驱动 pnpm。pnpm v11 会拦下 git 托管
    // 插件的 prepare 构建与传递原生依赖（见模块头注），其允许键不可预知，因此
    // 失败时解析输出里印出的 `allowBuilds` 键写回 profile 的 pnpm-workspace.yaml
    // 后重试，直至成功或再无键可加（升级路径同样依赖该重试，见
    // [`run_plugin_with_allow_build_retry`]）。
    let (exit_code, last_output) = run_plugin_with_allow_build_retry(
        app_handle,
        &node,
        &args,
        &cwd,
        &envs,
        &window,
        "install",
        cancel.as_ref(),
        owner,
    )
    .await?;

    if exit_code != 0 {
        log::error!("dsh plugin install failed with exit code {exit_code}");
        // 区分 git 传输层失败与 allowBuilds 构建门禁：前者是 pnpm 走了 git+ssh
        // （用户环境无 SSH 配置），后者才是补充白名单可自愈的。传输层错误给出
        // 可读指引，避免用户被 dsh 那条 allowBuilds 提示误导。
        let network_error = network_error_hint(&last_output).is_some()
            || (exit_code == 3 && last_output.trim().is_empty());
        let hint = git_transport_hint(&last_output);
        let network_hint = network_error.then_some(
            "NETWORK_ERROR: plugin registry request failed; check network or proxy settings and retry.",
        );
        let message = if network_error {
            network_hint.unwrap_or_default().to_string()
        } else {
            pick_error_message(&last_output, hint)
        };
        // 批量安装失败时给本次选中的每个插件记一条错误（前端据此展示异常标记，
        // 可针对单个插件重试更新/卸载）
        for id in ids {
            if let Err(e) = errors::record(app_handle, id, "install", &message) {
                log::warn!("failed to record plugin error for {id}: {e}");
            }
        }
        if let Some(network_hint) = network_hint {
            log::warn!("network failure detected during plugin install: {network_hint}");
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[network] {network_hint}"),
                },
            );
            // network_hint 已带 NETWORK_ERROR: 前缀，直接返回避免双重前缀
            return Err(network_hint.to_string());
        }
        if let Some(hint) = hint {
            log::warn!("git transport failure detected during plugin install: {hint}");
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] {hint}"),
                },
            );
            return Err(format!(
                "PREINSTALL_FAILED: dsh plugin exited with code {exit_code} ({hint})"
            ));
        }
        let detail = pick_error_message(&last_output, None);
        if !detail.is_empty() {
            log::error!("dsh plugin install diagnostic: {detail}");
        }
        return Err(format!(
            "PREINSTALL_FAILED: dsh plugin exited with code {exit_code}{}",
            diagnostic_suffix(&detail)
        ));
    }

    // 真正修复：核验本次安装是否真实落盘。pnpm 可能在 allowBuilds 阻断时仍以
    // exit 0 退出（假成功），若产物缺失则记录错误并返回 Err，让前端如实展示失败、
    // 允许重试，而不是误报「已安装」。已落盘的插件在上一步被核验并清除历史错误。
    verify_installed_products(app_handle, ids, &preset_map, &last_output)?;

    // 产物级核验：包已落盘但声明入口（如 `lib/index.js`）未构建时，本次安装
    // 同样是假成功——cordis 加载器在下一次启动必然 ERR_MODULE_NOT_FOUND 崩溃
    // （见 [`ensure_plugin_entry_built`]）。就地补构建或如实报错，不让坏态
    // 静默进入下一次启动；包目录按预设的 `installed_name` 解析（scoped 插件
    // 与 id 不同名），失败跨插件聚合后一次性返回，前端可一并重试。
    let mut entry_errors = Vec::new();
    for id in ids {
        let Some(preset) = preset_map.get(id.as_str()) else {
            continue;
        };
        let pkg_dir = profile_dir(app_handle)
            .join("node_modules")
            .join(installed_name(preset));
        if let Err(e) = ensure_plugin_entry_built(app_handle, id, &pkg_dir, &envs, &window).await {
            if let Err(err) = errors::record(app_handle, id, "install", &e) {
                log::warn!("failed to record plugin error for {id}: {err}");
            }
            entry_errors.push(format!("{id}: {e}"));
        }
    }
    if !entry_errors.is_empty() {
        return Err(format!(
            "PREINSTALL_ENTRY_FAILED:\n{}",
            entry_errors.join("\n")
        ));
    }

    // Windows 极简模式专项修复
    if ids.iter().any(|id| id == "dsh-win-terminal-inspector") {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector apply failed after install: {e}");
        }
    }

    // 告知用户安装阶段结束；随后的服务重启由前端 continueAfterPreinstall 负责
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: format!("[harness] 已安装 {} 个插件", ids.len()),
        },
    );

    log::info!("Preinstall plugins installed successfully: {ids:?}");
    Ok(())
}

async fn run_plugin_with_allow_build_retry(
    app_handle: &AppHandle,
    node: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &HashMap<String, String>,
    window: &WebviewWindow,
    action: &str,
    cancel: Option<&tokio::sync::watch::Receiver<bool>>,
    owner: ProcessOwner,
) -> Result<(i32, String), String> {
    let _operation_guard = acquire_operation_lock().await;
    let mut retries = 0usize;
    let mut all_output = String::new();
    let exit_code = loop {
        if cancel.is_some_and(|signal| *signal.borrow()) {
            return Err("PLUGIN_OPERATION_CANCELLED: plugin operation was cancelled".to_string());
        }
        let (code, captured) = run_plugin_process(node, args, cwd, envs, window, owner).await?;
        if cancel.is_some_and(|signal| *signal.borrow()) {
            return Err("PLUGIN_OPERATION_CANCELLED: plugin operation was cancelled".to_string());
        }
        append_command_output(&mut all_output, &captured);
        let new_keys = parse_allowlist_keys(&captured);
        // 有可补充的 allowBuilds 键且未达上限 → 写入并重试（无论本次退出码是否为 0，
        // 见上方注释：pnpm 可能在阻断时仍以 0 退出）。
        if !new_keys.is_empty() && retries < MAX_ALLOW_LIST_RETRIES {
            retries += 1;
            add_allow_build_keys(app_handle, &new_keys)?;
            log::info!("pnpm allowBuilds updated with {new_keys:?}, retrying {action} ({retries})");
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 已放行插件构建（allowBuilds），重试{action}…"),
                },
            );
            continue;
        }
        // 到达重试上限仍解析到待放行键：pnpm 的 exit 0 在 allowBuilds 场景不可信，
        // 直接视为失败（即便退出码为 0），交由调用方走失败 / 产物核验分支。
        if !new_keys.is_empty() {
            log::error!(
                "dsh plugin {action}: allowBuilds retry limit reached ({retries}), keys {new_keys:?} unresolved"
            );
            break if code == 0 { 1 } else { code };
        }
        if code != 0 {
            log::error!(
                "dsh plugin {action} failed with exit code {code}; no allowBuilds entries to add"
            );
        }
        break code;
    };
    Ok((exit_code, all_output))
}

/// 合并单次命令输出，并在相邻尝试之间补换行，保证后续错误解析不会粘连两段日志。
pub(super) fn append_command_output(all_output: &mut String, captured: &str) {
    if captured.is_empty() {
        return;
    }
    if !all_output.is_empty() && !all_output.ends_with('\n') {
        all_output.push('\n');
    }
    all_output.push_str(captured);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_output_retains_earlier_retry_diagnostics() {
        let mut output = String::new();
        append_command_output(&mut output, "ERR_PNPM_IGNORED_BUILDS");
        append_command_output(&mut output, "");

        assert_eq!(output, "ERR_PNPM_IGNORED_BUILDS");
    }
}
