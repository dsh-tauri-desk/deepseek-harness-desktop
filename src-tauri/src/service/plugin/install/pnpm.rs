//! pnpm 选版与版本探测：store 主版本感知（pnpm 10 与 11 的 store 布局互不兼容）、
//! 用户 pnpm 探测（注入桌面端选定 Node 的 PATH，见 issue #182；wait/cleanup 全程
//! 有界监控，见 probe 机制）、捆绑版按需补齐下载，以及服务启动时的
//! `DSH_PREFER_BUNDLED_PNPM` 决策（启动阶段不触发下载）。

use crate::config;
use crate::service::cli;
use crate::service::download;
use crate::service::download::Installable;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, WebviewWindow};

use super::acquire_process_lock;
use super::profile_dir;
use super::PidGuard;
use super::PreinstallLogPayload;
use super::ProcessOwner;
use super::PREINSTALL_LOG_EVENT;

const MIN_TRUSTED_PNPM_MAJOR: u32 = 10;
const PNPM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PNPM_PROBE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const PNPM_PROBE_REAP_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const PNPM_PROBE_REAP_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);
const PNPM_PROBE_LIVENESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

pub(super) async fn ensure_pnpm(
    app_handle: &AppHandle,
    window: &WebviewWindow,
    owner: ProcessOwner,
) -> Result<bool, String> {
    // 档案的 node_modules 由哪个 pnpm 主版本创建（.modules.yaml 的 storeDir 段）
    let store_major = profile_store_major(app_handle);
    let user_major = user_pnpm_major_version_bounded(app_handle, owner).await?;

    // 1) store 主版本已知 → 优先选与 store 一致的 pnpm（用户版或捆绑版）
    if let Some(store) = store_major {
        if user_major == Some(store) {
            log::info!("Reusing user-installed pnpm (major {store}) matching profile store");
            return Ok(false);
        }
        if bundled_pnpm_major(app_handle) == Some(store) {
            log::info!("Using bundled pnpm (major {store}) matching profile store");
            return Ok(true);
        }
        log::warn!(
            "No pnpm matches profile store major {store} (user {user_major:?}), falling back to user pnpm"
        );
    }

    // 2) store 未知（全新档案/未装过依赖）或无可匹配版本 → 用户 pnpm ≥ 10 优先
    match user_major {
        Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => {
            log::info!("Reusing user-installed pnpm (major {major}) for plugin install");
            return Ok(false);
        }
        Some(major) => {
            log::warn!(
                "User pnpm major {major} < {MIN_TRUSTED_PNPM_MAJOR} (missing autoInstallPeers/workspace-root semantics), using bundled pnpm"
            );
        }
        None => {
            log::warn!(
                "User pnpm version not detectable (broken/blocked shim?), using bundled pnpm"
            );
        }
    }

    // 捆绑版已存在 → 直接用（零额外下载）；否则下载。
    if config::get_pnpm_binary_path(app_handle).exists() {
        return Ok(true);
    }

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm not found, downloading before plugin install".to_string(),
        },
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
        .await
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm ready".to_string(),
        },
    );
    Ok(true)
}

async fn user_pnpm_major_version_bounded(
    app_handle: &AppHandle,
    owner: ProcessOwner,
) -> Result<Option<u32>, String> {
    let Some(pnpm) = cli::find_user_pnpm(app_handle) else {
        return Ok(None);
    };
    let node = config::get_node_binary_path(app_handle);
    let mut command = std::process::Command::new(&pnpm);
    command.arg("--version");
    if let Some(path) = pnpm_probe_path(&pnpm, Some(&node)) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let process_guard = acquire_process_lock().await?;
    let child = match command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::warn!(
                "pnpm version probe failed to spawn {}: {error}",
                pnpm.display()
            );
            return Ok(None);
        }
    };
    let pid = child.id();
    let pid_guard = PidGuard::set(owner, pid);
    let mut waiter = tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_for_probe_output(&mut child)
        }))
        .unwrap_or_else(|_| {
            super::super::cancel::terminate_pid_tree(pid);
            ProbeWaitResult::CleanupPending {
                pid,
                reason: format!(
                    "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe pid {pid} panicked before cleanup completed"
                ),
            }
        });
        match result {
            ProbeWaitResult::Finished(result) => ProbeTaskResult::Finished(result),
            ProbeWaitResult::CleanupPending { pid, reason } => {
                ProbeTaskResult::CleanupPending { child, pid, reason }
            }
        }
    });

    let output = match tokio::time::timeout(PNPM_PROBE_TIMEOUT, &mut waiter).await {
        Ok(joined) => {
            let Some(task) = probe_task_or_fallback(&pnpm, joined) else {
                let reason =
                    "PNPM_PROBE_WAIT_TASK_FAILED: pnpm version probe wait task failed".to_string();
                monitor_orphaned_probe_pid(owner, pid, reason, process_guard, pid_guard);
                return Ok(None);
            };
            match task {
                ProbeTaskResult::Finished(waited) => {
                    match probe_output_or_fallback(&pnpm, waited)? {
                        Some(output) => output,
                        None => return Ok(None),
                    }
                }
                ProbeTaskResult::CleanupPending { child, pid, reason } => {
                    let pending = ProbeCleanupPending {
                        child,
                        pid,
                        reason,
                        owner,
                        _process_guard: process_guard,
                        _pid_guard: pid_guard,
                    };
                    let reason = pending.reason.clone();
                    monitor_probe_cleanup(pending);
                    return Err(reason);
                }
            }
        }
        Err(_) => {
            let reason = format!(
                "PNPM_PROBE_TIMEOUT: pnpm version probe exceeded {} seconds",
                PNPM_PROBE_TIMEOUT.as_secs()
            );
            log::error!("{reason}");
            super::super::process::mark_process_cleanup_failed(owner, reason.clone());
            super::super::cancel::terminate_owned_install(owner).await;
            let cleanup = match tokio::time::timeout(PNPM_PROBE_CLEANUP_TIMEOUT, &mut waiter).await
            {
                Ok(cleanup) => cleanup,
                Err(_) => {
                    let cleanup_reason =
                        "PNPM_PROBE_CLEANUP_TIMEOUT: pnpm version probe did not exit after forced termination"
                            .to_string();
                    monitor_probe_wait_task(
                        waiter,
                        owner,
                        pid,
                        cleanup_reason.clone(),
                        process_guard,
                        pid_guard,
                    );
                    return Err(cleanup_reason);
                }
            };
            match cleanup {
                Ok(ProbeTaskResult::Finished(_)) => {
                    super::super::process::clear_process_cleanup_failed(owner);
                    return Err(reason);
                }
                Ok(ProbeTaskResult::CleanupPending { child, pid, reason }) => {
                    let pending = ProbeCleanupPending {
                        child,
                        pid,
                        reason,
                        owner,
                        _process_guard: process_guard,
                        _pid_guard: pid_guard,
                    };
                    let cleanup_reason = pending.reason.clone();
                    monitor_probe_cleanup(pending);
                    return Err(cleanup_reason);
                }
                Err(error) => {
                    monitor_orphaned_probe_pid(
                        owner,
                        pid,
                        format!(
                            "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe wait task failed during cleanup: {error}"
                        ),
                        process_guard,
                        pid_guard,
                    );
                    return Err(format!(
                        "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe wait task failed during cleanup: {error}"
                    ));
                }
            }
        }
    };
    Ok(parse_pnpm_major_output(&pnpm, &output))
}

enum ProbeWaitResult {
    Finished(std::io::Result<std::process::Output>),
    CleanupPending { pid: u32, reason: String },
}

enum ProbeTaskResult {
    Finished(std::io::Result<std::process::Output>),
    CleanupPending {
        child: std::process::Child,
        pid: u32,
        reason: String,
    },
}

struct ProbeCleanupPending {
    child: std::process::Child,
    pid: u32,
    reason: String,
    owner: ProcessOwner,
    _process_guard: tokio::sync::OwnedMutexGuard<()>,
    _pid_guard: PidGuard,
}

impl ProbeCleanupPending {
    fn release(self) {
        let Self {
            child,
            owner,
            _process_guard,
            _pid_guard,
            ..
        } = self;
        super::super::process::release_process_cleanup(owner, _pid_guard, _process_guard);
        drop(child);
    }
}

fn wait_for_probe_output(child: &mut std::process::Child) -> ProbeWaitResult {
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = match std::thread::Builder::new()
        .name("pnpm-probe-stdout".to_string())
        .spawn(move || read_probe_pipe(stdout))
    {
        Ok(reader) => reader,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };
    let stderr_reader = match std::thread::Builder::new()
        .name("pnpm-probe-stderr".to_string())
        .spawn(move || read_probe_pipe(stderr))
    {
        Ok(reader) => reader,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };
    let stdout = match join_probe_reader(stdout_reader) {
        Ok(stdout) => stdout,
        Err(error) => return ProbeWaitResult::Finished(Err(error)),
    };
    let stderr = match join_probe_reader(stderr_reader) {
        Ok(stderr) => stderr,
        Err(error) => return ProbeWaitResult::Finished(Err(error)),
    };
    ProbeWaitResult::Finished(Ok(std::process::Output {
        status,
        stdout,
        stderr,
    }))
}

fn reap_probe_after_wait_failure(
    child: &mut std::process::Child,
    pid: u32,
    error: std::io::Error,
) -> ProbeWaitResult {
    super::super::cancel::terminate_pid_tree(pid);
    if let Err(kill_error) = child.kill() {
        log::warn!("pnpm version probe kill after wait failure failed: {kill_error}");
    }
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return ProbeWaitResult::Finished(Err(error)),
            Ok(None) => {}
            Err(cleanup_error) => {
                log::warn!("pnpm version probe reap after wait failure failed: {cleanup_error}");
                if super::super::process::plugin_process_has_exited(pid) {
                    return ProbeWaitResult::Finished(Err(error));
                }
            }
        }
        if started.elapsed() >= PNPM_PROBE_REAP_RETRY_TIMEOUT {
            return ProbeWaitResult::CleanupPending {
                pid,
                reason: format!(
                    "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe pid {pid} could not be reaped after wait failure: {error}"
                ),
            };
        }
        std::thread::sleep(PNPM_PROBE_REAP_RETRY_INTERVAL);
    }
}

fn monitor_probe_cleanup(mut pending: ProbeCleanupPending) {
    super::super::process::mark_process_cleanup_failed(pending.owner, pending.reason.clone());
    tauri::async_runtime::spawn(async move {
        wait_for_probe_cleanup(&mut pending).await;
        pending.release();
    });
}

fn monitor_probe_wait_task(
    waiter: tauri::async_runtime::JoinHandle<ProbeTaskResult>,
    owner: ProcessOwner,
    pid: u32,
    reason: String,
    process_guard: tokio::sync::OwnedMutexGuard<()>,
    pid_guard: PidGuard,
) {
    super::super::process::mark_process_cleanup_failed(owner, reason);
    tauri::async_runtime::spawn(async move {
        match waiter.await {
            Ok(ProbeTaskResult::CleanupPending { child, pid, reason }) => {
                let mut pending = ProbeCleanupPending {
                    child,
                    pid,
                    reason,
                    owner,
                    _process_guard: process_guard,
                    _pid_guard: pid_guard,
                };
                wait_for_probe_cleanup(&mut pending).await;
                pending.release();
            }
            Ok(ProbeTaskResult::Finished(_)) => {
                super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
            }
            Err(error) => {
                log::error!("pnpm version probe cleanup wait task failed: {error}");
                wait_for_probe_cleanup_with(
                    || !super::super::process::plugin_process_has_exited(pid),
                    PNPM_PROBE_LIVENESS_INTERVAL,
                )
                .await;
                super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
            }
        }
    });
}

fn monitor_orphaned_probe_pid(
    owner: ProcessOwner,
    pid: u32,
    reason: String,
    process_guard: tokio::sync::OwnedMutexGuard<()>,
    pid_guard: PidGuard,
) {
    super::super::process::mark_process_cleanup_failed(owner, reason);
    super::super::cancel::terminate_pid_tree(pid);
    tauri::async_runtime::spawn(async move {
        wait_for_probe_cleanup_with(
            || !super::super::process::plugin_process_has_exited(pid),
            PNPM_PROBE_LIVENESS_INTERVAL,
        )
        .await;
        super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
    });
}

async fn wait_for_probe_cleanup(pending: &mut ProbeCleanupPending) {
    wait_for_probe_cleanup_with(
        || match pending.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(error) => {
                log::warn!(
                    "pnpm version probe cleanup monitor wait failed for pid {}: {error}",
                    pending.pid
                );
                !super::super::process::plugin_process_has_exited(pending.pid)
            }
        },
        PNPM_PROBE_LIVENESS_INTERVAL,
    )
    .await;
    log::info!(
        "pnpm version probe cleanup monitor released pid {}",
        pending.pid
    );
}

async fn wait_for_probe_cleanup_with<F>(mut remains_active: F, interval: std::time::Duration)
where
    F: FnMut() -> bool,
{
    while remains_active() {
        tokio::time::sleep(interval).await;
    }
}

fn read_probe_pipe<R: Read>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut output)?;
    }
    Ok(output)
}

fn join_probe_reader(
    reader: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> std::io::Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| std::io::Error::other("pnpm version probe output reader thread panicked"))?
}

fn log_probe_fallback(pnpm: &Path, phase: &str, error: impl std::fmt::Display) {
    log::warn!(
        "pnpm version probe {phase} failed for {}: {error}; falling back to bundled pnpm",
        pnpm.display()
    );
}

fn probe_task_or_fallback<T, E: std::fmt::Display>(pnpm: &Path, result: Result<T, E>) -> Option<T> {
    match result {
        Ok(task) => Some(task),
        Err(error) => {
            log_probe_fallback(pnpm, "wait task", error);
            None
        }
    }
}

fn probe_output_or_fallback(
    pnpm: &Path,
    result: std::io::Result<std::process::Output>,
) -> Result<Option<std::process::Output>, String> {
    match result {
        Ok(output) => Ok(Some(output)),
        Err(error) => {
            log_probe_fallback(pnpm, "output", error);
            Ok(None)
        }
    }
}

/// 用户 pnpm 主版本号（解析 `pnpm --version` 首个点分字段）；不存在或不可运行
/// （corepack shim 在 Node 24 上 ERR_INVALID_THIS 崩溃等）返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn user_pnpm_major_version(app_handle: &AppHandle) -> Option<u32> {
    let pnpm = cli::find_user_pnpm(app_handle)?;
    let node = config::get_node_binary_path(app_handle);
    pnpm_major_version_at_with_node(&pnpm, Some(&node))
}

/// 探测精确 pnpm 可执行路径的主版本，供直接执行路径校验实际将运行的文件。
pub(crate) fn pnpm_major_version_at(pnpm: &Path) -> Option<u32> {
    pnpm_major_version_at_with_node(pnpm, None)
}

/// 在受控 Node 环境中探测 pnpm 主版本。Windows GUI 进程继承的 PATH 可能早于
/// Node/pnpm 安装，而 corepack 的 `pnpm.cmd` 需要通过 PATH 调用 `node`；探测时
/// 必须注入桌面端已经选定的 Node 目录，否则会把健康 pnpm 误判为不可用（issue #182）。
fn pnpm_major_version_at_with_node(pnpm: &Path, node: Option<&Path>) -> Option<u32> {
    let mut cmd = std::process::Command::new(pnpm);
    cmd.arg("--version");
    if let Some(path) = pnpm_probe_path(pnpm, node) {
        cmd.env("PATH", path);
    }
    // 打包版是 GUI 进程（无控制台）：版本探测不能弹出可见黑窗。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = match cmd.output() {
        Ok(output) => output,
        Err(error) => {
            log::warn!(
                "pnpm version probe failed to spawn {}: {error}",
                pnpm.display()
            );
            return None;
        }
    };
    parse_pnpm_major_output(pnpm, &output)
}

fn parse_pnpm_major_output(pnpm: &Path, output: &std::process::Output) -> Option<u32> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "pnpm version probe failed for {} with status {}: {}",
            pnpm.display(),
            output.status,
            stderr.trim()
        );
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.split('.').next()?.trim().parse::<u32>().ok()
}

/// 构建 pnpm 探测专用 PATH：用户 pnpm 所在目录和选定 Node 目录前置，其余环境保留。
fn pnpm_probe_path(pnpm: &Path, node: Option<&Path>) -> Option<OsString> {
    let mut paths = Vec::new();
    // 选定 Node 必须位于 pnpm shim 目录之前：corepack 目录可能残留另一份 node，
    // bare `node` 应与桌面端预检和后续插件命令使用同一运行时。
    if let Some(parent) = node.and_then(Path::parent) {
        paths.push(parent.to_path_buf());
    }
    if let Some(parent) = pnpm.parent() {
        paths.push(parent.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(paths).ok()
}

/// 档案 `node_modules` 使用的 pnpm store 主版本（`<profile>/node_modules/.modules.yaml`
/// 的 `storeDir` 路径段，如 `...\store\v10` → 10）。
///
/// pnpm 10 与 11 的 store 布局互不兼容：用与 store 主版本不一致的 pnpm 更新
/// 已装插件会 `ERR_PNPM_UNEXPECTED_STORE` 退出。档案尚未安装过依赖（没有
/// node_modules）时返回 `None`，由调用方走"全新档案"逻辑。
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用。
pub(crate) fn profile_store_major(app_handle: &AppHandle) -> Option<u32> {
    let modules_yaml = profile_dir(app_handle)
        .join("node_modules")
        .join(".modules.yaml");
    let content = std::fs::read_to_string(modules_yaml).ok()?;
    parse_store_major_from_modules_yaml(&content)
}

/// 从 `.modules.yaml` 文本解析 store 主版本（纯函数，便于单测）。
fn parse_store_major_from_modules_yaml(content: &str) -> Option<u32> {
    let store_dir = content
        .lines()
        .find_map(|line| line.trim().strip_prefix("storeDir:").map(str::trim))?;
    // storeDir 形如 `C:\Users\xx\AppData\Local\pnpm\store\v10`，取末段 `v10` 的数字
    let major = store_dir
        .trim_matches(['"', '\''])
        .rsplit(['\\', '/'])
        .next()?
        .strip_prefix('v')?;
    major.parse().ok()
}

/// 捆绑版 pnpm 的主版本（读 `dependencies/pnpm/package.json` 的 version 字段）；
/// 未安装或清单缺失返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn bundled_pnpm_major(app_handle: &AppHandle) -> Option<u32> {
    let manifest = config::get_pnpm_install_path(app_handle).join("package.json");
    let content = std::fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value
        .get("version")?
        .as_str()?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// 服务启动阶段的 `DSH_PREFER_BUNDLED_PNPM` 决策：store 主版本已知时只在捆绑版
/// 匹配且用户版不匹配时强制捆绑版（否则用户版会 `ERR_PNPM_UNEXPECTED_STORE`）；
/// store 未知时用户 pnpm ≥ 10 优先，否则强制捆绑版。启动阶段绝不触发下载，
/// 捆绑版未安装即返回 false（交由用户 pnpm）。
pub(crate) fn harness_prefer_bundled_pnpm(app_handle: &AppHandle) -> bool {
    let store_major = profile_store_major(app_handle);
    let user_major = user_pnpm_major_version(app_handle);
    let bundled_major = bundled_pnpm_major(app_handle);
    // 捆绑版未安装 → 无法强制，交还用户 pnpm（shim 默认用户优先）
    if !config::get_pnpm_binary_path(app_handle).exists() {
        return false;
    }
    match store_major {
        Some(store) => bundled_major == Some(store) && user_major != Some(store),
        None => match user_major {
            Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => false,
            _ => true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnpm_probe_wait_and_output_failures_fall_back_to_bundled() {
        let pnpm = PathBuf::from("broken-pnpm");
        let output = probe_output_or_fallback(
            &pnpm,
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "output pipe closed",
            )),
        )
        .unwrap();

        assert!(output.is_none());
    }

    #[test]
    fn pnpm_probe_wait_task_join_failure_falls_back_to_bundled() {
        let pnpm = PathBuf::from("broken-pnpm");
        let task: Option<()> = probe_task_or_fallback(&pnpm, Err("blocking worker dropped"));
        assert!(task.is_none());
    }

    #[tokio::test]
    async fn pnpm_probe_cleanup_monitor_releases_after_process_disappears() {
        let polls = std::sync::atomic::AtomicUsize::new(0);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            wait_for_probe_cleanup_with(
                || polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2,
                std::time::Duration::from_millis(1),
            ),
        )
        .await
        .expect("cleanup monitor should release after liveness turns false");
        assert_eq!(polls.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn pnpm_probe_cleanup_monitor_stays_fail_closed_while_process_lives() {
        let pending = tokio::time::timeout(
            std::time::Duration::from_millis(5),
            wait_for_probe_cleanup_with(|| true, std::time::Duration::from_millis(1)),
        )
        .await;
        assert!(pending.is_err());
    }

    struct BrokenPipeReader;

    impl std::io::Read for BrokenPipeReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "probe output pipe closed",
            ))
        }
    }

    #[test]
    fn pnpm_probe_broken_output_pipe_is_reported_as_fallback_failure() {
        let error = read_probe_pipe(Some(BrokenPipeReader)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[cfg(unix)]
    #[test]
    fn pnpm_major_version_at_probes_the_exact_selected_path() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh-pnpm-major-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let selected = root.join("selected-pnpm");
        let other = root.join("other-pnpm");
        std::fs::write(&selected, "#!/bin/sh\nprintf '11.2.0\\n'\n").unwrap();
        std::fs::write(&other, "#!/bin/sh\nprintf '10.9.0\\n'\n").unwrap();
        for path in [&selected, &other] {
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(path, permissions).unwrap();
        }

        assert_eq!(pnpm_major_version_at(&selected), Some(11));
        assert_eq!(pnpm_major_version_at(&other), Some(10));
        let _ = std::fs::remove_dir_all(root);
    }

    /// 回归 Windows GUI 的陈旧 PATH：pnpm shim 必须解析到桌面端选定的 Node，
    /// 即使 shim 同目录存在冲突的 node，且路径包含空格和 shell 元字符。
    #[cfg(windows)]
    #[test]
    fn pnpm_major_version_probe_injects_selected_node_for_cmd_shim() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh pnpm cmd major {} {nonce}", std::process::id()));
        let pnpm_dir = root.join("pnpm & corepack");
        let node_dir = root.join("selected node");
        std::fs::create_dir_all(&pnpm_dir).unwrap();
        std::fs::create_dir_all(&node_dir).unwrap();
        let selected = pnpm_dir.join("pnpm.cmd");
        let node = node_dir.join("node.cmd");
        std::fs::write(&selected, "@echo off\r\nnode --version\r\n").unwrap();
        // shim 目录里的冲突运行时若优先会输出 9；选定 Node 必须抢在它前面。
        std::fs::write(pnpm_dir.join("node.cmd"), "@echo off\r\necho 9.0.0\r\n").unwrap();
        std::fs::write(&node, "@echo off\r\necho 11.24.0\r\n").unwrap();

        assert_eq!(
            pnpm_major_version_at_with_node(&selected, Some(&node)),
            Some(11)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn store_major_parsed_from_modules_yaml() {
        // 真实 pnpm v10 写入的 .modules.yaml：storeDir 指向 store\v10
        let content = "\
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
dependencies:
  '@deepseek-ai/dsh-base': 0.0.4
  '@deepseek-ai/dsh-web-app': 0.0.4
storeDir: C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10
virtualStoreDir: node_modules/.pnpm
";
        assert_eq!(parse_store_major_from_modules_yaml(content), Some(10));
    }

    #[test]
    fn store_major_supports_unix_and_quoted_paths() {
        assert_eq!(
            parse_store_major_from_modules_yaml(
                "storeDir: /home/test/.local/share/pnpm/store/v11\n"
            ),
            Some(11)
        );
        assert_eq!(
            parse_store_major_from_modules_yaml("storeDir: \"C:\\\\pnpm store\\\\v3\"\n"),
            Some(3)
        );
    }

    #[test]
    fn store_major_missing_when_no_store_dir() {
        // 档案尚未装过依赖：无 storeDir 段 → None
        assert_eq!(
            parse_store_major_from_modules_yaml("lockfileVersion: '9.0'\n"),
            None
        );
        assert_eq!(parse_store_major_from_modules_yaml(""), None);
        assert_eq!(
            parse_store_major_from_modules_yaml("storeDir: C:\\Users\\x\\pnpm\\store\n"),
            None
        );
    }
}
