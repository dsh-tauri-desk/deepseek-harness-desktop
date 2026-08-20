//! 插件安装/移除：校验选中项、准备环境（pnpm/dsh shim、按需补齐捆绑 pnpm、
//! 停止运行中的服务），随后调用 `dsh plugin --profile web add/remove ...`；
//! 安装成功后执行 Windows 极简模式专项修复，移除成功后清理残留挂载。

use crate::config;
use crate::service::cli;
use crate::service::download;
use crate::service::download::Installable;
use crate::service::workflow;
use std::collections::HashMap;
use std::ffi::OsString;
use tauri::{AppHandle, Manager, WebviewWindow};

use super::installed::PREINSTALL_PROFILE;
use super::preset::load_presets;
use super::process::{emit_plugin_log, run_plugin_process};

/// 准备桌面端自带的 Node/dsh/pnpm 环境并执行一个受控 dsh 命令。
async fn run_plugin_command(app_handle: &AppHandle, args: &[OsString]) -> Result<i32, String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    let mut command = String::from("dsh");
    for arg in args.iter().skip(1) {
        command.push(' ');
        command.push_str(&arg.to_string_lossy());
    }
    emit_plugin_log(&window, format!("[desktop] Running command: {command}"));

    emit_plugin_log(&window, "[desktop] Ensuring dsh/pnpm shims");
    if let Err(error) = cli::ensure_shims(app_handle) {
        emit_plugin_log(&window, format!("[desktop] Failed to ensure shims: {error}"));
        return Err(error);
    }
    emit_plugin_log(&window, "[desktop] dsh/pnpm shims ready");

    let node = config::get_node_binary_path(app_handle);
    let dsh_bin = config::get_dsh_binary_path(app_handle);
    if !node.exists() {
        let error = "NODE_NOT_FOUND: Node.js runtime missing".to_string();
        emit_plugin_log(&window, format!("[desktop] {error}"));
        return Err(error);
    }
    if !dsh_bin.exists() {
        let error = "HARNESS_NOT_FOUND: dsh CLI missing".to_string();
        emit_plugin_log(&window, format!("[desktop] {error}"));
        return Err(error);
    }

    // 按需补齐捆绑 pnpm
    emit_plugin_log(&window, "[desktop] Checking pnpm runtime");
    if let Err(error) = ensure_pnpm(app_handle, &window).await {
        emit_plugin_log(&window, format!("[desktop] pnpm preparation failed: {error}"));
        return Err(error);
    }

    // 命令前停止运行中的服务，避免 profile 文件与运行中的 loader 冲突
    if workflow::has_owned_process() {
        log::info!("Stopping running harness service before dsh plugin command");
        emit_plugin_log(&window, "[desktop] Stopping the owned Harness process");
        if let Err(error) = workflow::stop(app_handle.clone()).await {
            log::warn!("failed to stop harness before dsh plugin command: {error}");
            emit_plugin_log(&window, format!("[desktop] Warning: failed to stop Harness: {error}"));
        } else {
            emit_plugin_log(&window, "[desktop] Owned Harness process stopped");
        }
    } else {
        emit_plugin_log(&window, "[desktop] No owned Harness process is running");
    }

    // 构建环境变量
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut envs = HashMap::from([
        (
            "DSH_HOME".to_string(),
            config::get_dsh_data_path(app_handle)
                .to_string_lossy()
                .into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ]);

    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node.parent() {
        paths.push(node_dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));

    if let Ok(joined) = std::env::join_paths(paths) {
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }

    let cwd = config::get_dsh_install_path(app_handle);
    emit_plugin_log(&window, "[desktop] Starting dsh plugin process");
    match run_plugin_process(&node, args, &cwd, &envs, &window).await {
        Ok(exit_code) => {
            emit_plugin_log(
                &window,
                format!("[desktop] dsh plugin process exited with code {exit_code}"),
            );
            Ok(exit_code)
        }
        Err(error) => {
            emit_plugin_log(&window, format!("[desktop] dsh plugin process failed: {error}"));
            Err(error)
        }
    }
}
/// 确保捆绑 pnpm 已安装
async fn ensure_pnpm(app_handle: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if download::Pnpm.check_installed(app_handle) {
        emit_plugin_log(window, "[pnpm] user or bundled pnpm is available");
        return Ok(());
    }

    emit_plugin_log(
        window,
        "[pnpm] bundled pnpm not found, downloading before dsh plugin command",
    );

    let tracker = download::ProgressTracker::new(window, 2);
    let url = download::Pnpm.get_download_url()?;
    let name = url.split('/').next_back().unwrap_or(&url).to_string();
    let buffer = download::download_file(&tracker, url)
        .await
        .map_err(|e| format!("PNPM_DOWNLOAD_FAILED: {e}"))?;
    download::verify_sha256(&buffer, config::PNPM_SHA256)
        .map_err(|e| format!("PNPM_INTEGRITY_FAILED: {e}"))?;
    let dest = download::Pnpm.get_install_path(app_handle);

    download::ensure_extract(&tracker, name, buffer, dest)
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;

    emit_plugin_log(window, "[pnpm] bundled pnpm ready");
    Ok(())
}

/// 校验并安装选中的预装插件：`dsh plugin --profile web add <ids...>`
pub async fn install(app_handle: &AppHandle, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Err("PREINSTALL_EMPTY: no plugins selected".to_string());
    }

    // 单次读取预设并构建查找表，提升算法效率至 O(N)
    let presets = load_presets(app_handle);
    let preset_map: HashMap<&str, &str> = presets
        .iter()
        .map(|p| (p.id.as_str(), p.spec.as_str()))
        .collect();

    let mut specs = Vec::with_capacity(ids.len());
    for id in ids {
        let spec = preset_map
            .get(id.as_str())
            .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
        specs.push(spec.to_string());
    }

    let dsh_bin = config::get_dsh_binary_path(app_handle);
    let mut args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(PREINSTALL_PROFILE),
        OsString::from("add"),
    ];
    args.extend(specs.into_iter().map(OsString::from));

    log::info!("Running dsh plugin install for {ids:?}");
    let exit_code = run_plugin_command(app_handle, &args).await?;
    if exit_code != 0 {
        log::error!("dsh plugin install failed with exit code {exit_code}");
        return Err(format!(
            "PREINSTALL_FAILED: dsh plugin exited with code {exit_code}"
        ));
    }

    // Windows 极简模式专项修复
    if ids.iter().any(|id| id == "dsh-win-terminal-inspector") {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector apply failed after install: {e}");
        }
    }

    log::info!("Preinstall plugins installed successfully: {ids:?}");
    Ok(())
}

/// 校验并移除一个已加载的用户插件：`dsh plugin --profile web remove <id>`
pub async fn remove(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("PLUGIN_REMOVE_EMPTY: plugin id is empty".to_string());
    }

    let plugin = super::watch::list(app_handle)
        .into_iter()
        .find(|plugin| plugin.id == id)
        .ok_or_else(|| format!("PLUGIN_NOT_FOUND: {id}"))?;
    if !plugin.bundled {
        return Err(format!("PLUGIN_NOT_BUNDLED: {id}"));
    }
    if !plugin.removable {
        return Err(format!("PLUGIN_PROTECTED: {id}"));
    }

    let dsh_bin = config::get_dsh_binary_path(app_handle);
    // pnpm remove 仍会校验整个 lockfile；卸载不会引入新包，仅对该命令关闭
    // minimumReleaseAge，保留安装流程的供应链策略校验。
    let args = vec![
        dsh_bin.as_os_str().to_os_string(),
        OsString::from("plugin"),
        OsString::from("--profile"),
        OsString::from(PREINSTALL_PROFILE),
        OsString::from("remove"),
        OsString::from(id),
        OsString::from("--config.minimum-release-age=0"),
    ];

    log::info!("Running dsh plugin remove for {id}");
    let exit_code = run_plugin_command(app_handle, &args).await?;
    if exit_code != 0 {
        log::error!("dsh plugin remove failed for {id} with exit code {exit_code}");
        return Err(format!(
            "PLUGIN_REMOVE_FAILED: dsh plugin exited with code {exit_code}"
        ));
    }

    if let Err(e) = workflow::win_inspector::apply(app_handle) {
        log::warn!("win inspector cleanup failed after removing {id}: {e}");
    }

    log::info!("Plugin removed successfully: {id}");
    Ok(())
}

