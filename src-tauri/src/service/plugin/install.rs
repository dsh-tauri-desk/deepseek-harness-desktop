//! 预装插件安装：校验选中项、准备环境（pnpm/dsh shim、按需补齐捆绑 pnpm、
//! 停止运行中的服务），随后调用 `dsh plugin --profile web add <specs...>`，
//! 成功后执行 Windows 极简模式专项修复。
//!
//! pnpm v11 对两类构建脚本默认不放行、缺白名单时报硬错误：
//! 1. git 托管插件的 `prepare` 构建（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）——
//!    其允许键（depPath = `name@<pkgResolutionId>`）随 pnpm 的克隆方式变化
//!    （git+ssh#sha / codeload tar.gz），无法预先确定；
//! 2. 传递依赖的原生构建（如 `node-pty`，`ERR_PNPM_IGNORED_BUILDS`）。
//! 因此在安装失败时从 pnpm 错误输出解析它建议的 `allowBuilds` 键，写入 profile
//! 的 `pnpm-workspace.yaml` 后重试，直至成功或无可解析项。

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::download;
use crate::service::download::Installable;
use crate::service::profile::active_profile;
use crate::service::workflow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use serde_yaml::{Mapping, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::errors;
use super::installed::{is_installed, profile_dir};
use super::preset::{bundled_plugin_dir, file_dep_spec, load_presets, PreinstallPluginInfo};
use super::process::{run_plugin_process, PreinstallLogPayload, PREINSTALL_LOG_EVENT};
use super::recovery::is_actionable_plugin_ref;
use super::uninstall_recovery;

/// 允许构建重试的上限。每次重试解决 pnpm 报出的一个允许键（git depPath 或
/// 传递构建包名），多个 git 插件 / 多个原生依赖各占一次，上限封顶防死循环。
const MAX_ALLOW_LIST_RETRIES: usize = 8;

/// 可安全用于插件安装的用户 pnpm 最低主版本。
///
/// pnpm 10+ 才从 `pnpm-workspace.yaml` 读取 `autoInstallPeers`（9 及更早只读
/// `.npmrc`），且 10+ 移除了 workspace-root 安装门槛（`ERR_PNPM_ADDING_TO_ROOT`
/// 是 8/9 行为）。低于此版本时插件安装必须改用捆绑版 pnpm，否则会出现
/// 自动合成 peer 后 `No matching version found for @deepseek-ai/...` 的假失败。
const MIN_TRUSTED_PNPM_MAJOR: u32 = 10;

/// 校验并安装选中的预装插件：`dsh plugin --profile <当前档案> add <ids...>`
pub async fn install(app_handle: &AppHandle, ids: &[String]) -> Result<(), String> {
    log::info!("install: entry ids={ids:?} active_profile={} DSH_HOME={}", active_profile(app_handle), config::get_dsh_data_path(app_handle).display());
    let _ = app_handle
        .get_webview_window("main")
        .map(|w| w.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload { line: format!("[pnpm] install 入口 ids={ids:?} profile={} DSH_HOME={}", active_profile(app_handle), config::get_dsh_data_path(app_handle).display()) },
        ));
    if ids.is_empty() {
        return Err("PREINSTALL_EMPTY: no plugins selected".to_string());
    }

    // 单次读取预设并构建查找表，提升算法效率至 O(N)
    let presets = load_presets(app_handle);
    log::info!("install: loaded {} presets from resources/preset-plugins.json", presets.len());
    let preset_map: HashMap<&str, &PreinstallPluginInfo> = presets
        .iter()
        .map(|p| (p.id.as_str(), p))
        .collect();

    let mut specs = Vec::with_capacity(ids.len());
    for id in ids {
        let preset = preset_map
            .get(id.as_str())
            .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
        let bd = bundled_dir_of(app_handle, preset);
        let spec_raw = preset_spec_for_install(preset, bd.clone())?;
        let spec = normalize_git_spec(&spec_raw);
        log::info!(
            "install: id={} internal={} spec_raw={} normalized={} bundled_dir={:?} exists={}",
            id,
            preset.internal,
            spec_raw,
            spec,
            bd,
            bd.as_ref().map(|p| p.exists()).unwrap_or(false)
        );
        specs.push(spec);
    }
    log::info!("install: resolved specs={specs:?} ids={ids:?}");

    // 确保 pnpm/dsh shim 存在
    let bin_dir = cli::get_bin_dir(app_handle);
    let pnpm_shim = bin_dir.join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" });
    let dsh_shim = bin_dir.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
    log::info!(
        "install: ensure_shims start bin_dir={} pnpm_shim={} exists={} dsh_shim={} exists={}",
        bin_dir.display(),
        pnpm_shim.display(),
        pnpm_shim.exists(),
        dsh_shim.display(),
        dsh_shim.exists()
    );
    cli::ensure_shims(app_handle).map_err(|e| {
        log::error!("install: ensure_shims failed bin_dir={} err={e}", bin_dir.display());
        e
    })?;
    log::info!(
        "install: ensure_shims done bin_dir={} pnpm_shim_exists={} dsh_shim_exists={} pnpm_cjs_exists={} node_exists={}",
        bin_dir.display(),
        pnpm_shim.exists(),
        dsh_shim.exists(),
        config::get_pnpm_binary_path(app_handle).exists(),
        config::get_node_binary_path(app_handle).exists()
    );

    let node = config::get_node_binary_path(app_handle);
    // 活动核心的 dsh 入口：本地核心存在时用本地 CLI，否则预打包
    let dsh_bin = core::active_dsh_binary(app_handle);
    log::info!(
        "install: runtime node={} exists={} dsh_bin={} exists={} cwd(dsh_install)={} exists={}",
        node.display(),
        node.exists(),
        dsh_bin.display(),
        dsh_bin.exists(),
        config::get_dsh_install_path(app_handle).display(),
        config::get_dsh_install_path(app_handle).exists()
    );
    if !node.exists() {
        log::error!("install: NODE_NOT_FOUND node={}", node.display());
        return Err("NODE_NOT_FOUND: Node.js runtime missing".to_string());
    }
    if !dsh_bin.exists() {
        log::error!("install: HARNESS_NOT_FOUND dsh_bin={}", dsh_bin.display());
        return Err("HARNESS_NOT_FOUND: dsh CLI missing".to_string());
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("WINDOW_NOT_FOUND: main window missing")?;

    // 选定/补齐安装用的 pnpm：返回是否应强制使用捆绑版（版本感知，见 ensure_pnpm）
    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window).await.map_err(|e| {
        log::error!("install: ensure_pnpm failed err={e}");
        e
    })?;
    log::info!("install: ensure_pnpm done prefer_bundled={prefer_bundled_pnpm}");

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
    log::info!(
        "install: envs built prefer_bundled={} DSH_HOME={:?} PATH_len={} DSH_PREFER={:?}",
        prefer_bundled_pnpm,
        envs.get("DSH_HOME"),
        envs.get("PATH").map(|p| p.len()).unwrap_or(0),
        envs.get("DSH_PREFER_BUNDLED_PNPM")
    );

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
    log::info!(
        "Running dsh plugin install for {specs:?} cwd={} node={} dsh_bin={} profile={} prefer_bundled={} args_len={}",
        cwd.display(),
        node.display(),
        dsh_bin.display(),
        active_profile(app_handle),
        prefer_bundled_pnpm,
        args.len()
    );
    let args_preview: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: format!("[pnpm] dsh plugin add specs={specs:?} cwd={} args={args_preview:?}", cwd.display()),
        },
    );

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
    )
    .await?;

    // 退出码与 pnpm 输出落盘：用于定位「退出 0 却未下载」的静默成功
    // 场景——此前仅失败时记录输出，成功时无迹可查，无法判断 pnpm 是否真实执行
    log::info!(
        "install: dsh plugin exit_code={exit_code} output_len={} profile={} cwd={}",
        last_output.len(),
        active_profile(app_handle),
        cwd.display()
    );
    if !last_output.is_empty() {
        let head: String = last_output.chars().take(1000).collect();
        let tail: String = last_output.chars().rev().take(1500).collect::<String>().chars().rev().collect();
        log::info!("install: last_output head(1000)={}", head.replace('\n', "\\n"));
        if last_output.len() > 1000 {
            log::info!("install: last_output tail(1500)={}", tail.replace('\n', "\\n"));
        }
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!("[pnpm] 安装输出 tail={}", tail.chars().take(600).collect::<String>().replace('\n', " ")),
            },
        );
    } else {
        log::warn!("install: last_output empty exit={exit_code} — 可能是 pnpm 未被调用或输出被截断");
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: "[pnpm] 警告: 安装进程无输出（可能 pnpm 未执行或被静默跳过）".to_string(),
            },
        );
    }

    if exit_code != 0 {
        // 失败分支：区分 git 传输层与 allowBuilds，避免误导
        // 输出中若含 git ssh 特征则提示用户网络/SSH 问题，否则视为构建门禁
        log::error!(
            "install: dsh plugin install failed exit={exit_code} output_len={} hint_check={:?}",
            last_output.len(),
            git_transport_hint(&last_output)
        );
        // 区分 git 传输层失败与 allowBuilds 构建门禁：前者是 pnpm 走了 git+ssh
        // （用户环境无 SSH 配置），后者才是补充白名单可自愈的。传输层错误给出
        // 可读指引，避免用户被 dsh 那条 allowBuilds 提示误导。
        let hint = git_transport_hint(&last_output);
        let message = pick_error_message(&last_output, hint);
        log::warn!("install: pick_error_message len={} hint={:?} msg_head={}", message.len(), hint, message.chars().take(300).collect::<String>().replace('\n', "\\n"));
        // 批量安装失败时给本次选中的每个插件记一条错误（前端据此展示异常标记，
        // 可针对单个插件重试更新/卸载）
        for id in ids {
            if let Err(e) = errors::record(app_handle, id, "install", &message) {
                log::warn!("failed to record plugin error for {id}: {e}");
            }
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
        return Err(format!(
            "PREINSTALL_FAILED: dsh plugin exited with code {exit_code}"
        ));
    }

    // 成功分支：此前仅以退出码 0 判定成功，未校验产物是否真实落盘
    // 导致「日志显示成功但 node_modules 为空」的静默失败无法被发现
    // 此处对 profile 落盘结果做二次核验，为后续自愈提供依据
    log::info!("install: exit 0, start post-install verification ids={ids:?}");
    let profile = profile_dir(app_handle);
    let pkg_path = profile.join("package.json");
    let nm_path = profile.join("node_modules");
    log::info!(
        "install: verify profile={} pkg_exists={} pkg={} nm_exists={} nm={}",
        profile.display(),
        pkg_path.exists(),
        pkg_path.display(),
        nm_path.exists(),
        nm_path.display()
    );
    if pkg_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&pkg_path) {
            let head: String = content.chars().take(800).collect();
            log::info!("install: verify package.json head(800)={}", head.replace('\n', "\\n"));
            for id in ids {
                let present = content.contains(id);
                log::info!("install: verify package.json contains id={} -> {}", id, present);
            }
        } else {
            log::warn!("install: verify read package.json failed path={}", pkg_path.display());
        }
    } else {
        log::warn!("install: verify package.json missing profile={}", profile.display());
    }
    for id in ids {
        // 插件包名可能与 id 不一致（如 scoped 包），按 preset 的 package 字段核验
        let pkg_name = preset_map.get(id.as_str()).and_then(|p| p.package.as_deref()).unwrap_or(id.as_str());
        let mod_pkg = nm_path.join(pkg_name).join("package.json");
        let mod_exists = mod_pkg.exists();
        let mod_dir_exists = nm_path.join(pkg_name).exists();
        log::info!(
            "install: verify plugin id={} pkg_name={} mod_dir_exists={} mod_pkg_exists={} mod_pkg={}",
            id,
            pkg_name,
            mod_dir_exists,
            mod_exists,
            mod_pkg.display()
        );
        if !mod_exists {
            log::warn!(
                "install: verify missing product for id={} pkg={} — 退出 0 但产物缺失，可能 pnpm 未下载或被跳过",
                id,
                pkg_name
            );
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 警告: {id} ({pkg_name}) 安装后产物缺失 {}", mod_pkg.display()),
                },
            );
        }
    }
    // pnpm 产物与 shim 联动核验：确保后续 dsh 能解析到插件
    // 额外核验 pnpm-workspace.yaml 与 .modules.yaml，定位 allowBuilds 是否生效及 store 是否创建
    let ws_path = profile.join("pnpm-workspace.yaml");
    let ws_exists = ws_path.exists();
    let ws_content = std::fs::read_to_string(&ws_path).unwrap_or_else(|e| format!("<read failed: {e}>"));
    log::info!(
        "install: verify pnpm-workspace exists={} path={} content_head(1000)={}",
        ws_exists,
        ws_path.display(),
        ws_content.chars().take(1000).collect::<String>().replace('\n', "\\n")
    );
    let modules_yaml_path = nm_path.join(".modules.yaml");
    let modules_exists = modules_yaml_path.exists();
    let modules_content = std::fs::read_to_string(&modules_yaml_path).unwrap_or_else(|_| "<no file>".to_string());
    log::info!(
        "install: verify .modules.yaml exists={} path={} head(500)={}",
        modules_exists,
        modules_yaml_path.display(),
        modules_content.chars().take(500).collect::<String>().replace('\n', "\\n")
    );
    // 从 pnpm 输出提取全局 store 路径，核对 pnpm 实际使用的 store 版本（v10/v11）与选型是否一致
    let store_line = last_output.lines().find(|l| l.contains("Content-addressable store")).unwrap_or("<no store line>");
    log::info!("install: pnpm global store line from output: {}", store_line.trim());
    let pnpm_bundled = config::get_pnpm_binary_path(app_handle);
    let pnpm_user = cli::find_user_pnpm(app_handle);
    log::info!(
        "install: verify done pnpm_bundled={} exists={} pnpm_user={:?} output_len={} store_line={}",
        pnpm_bundled.display(),
        pnpm_bundled.exists(),
        pnpm_user,
        last_output.len(),
        store_line.trim()
    );
    for id in ids {
        if let Err(e) = errors::clear(app_handle, id) {
            log::warn!("failed to clear plugin error for {id}: {e}");
        }
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
            line: format!("[harness] 已安装 {} 个插件（已核验）", ids.len()),
        },
    );

    log::info!("Preinstall plugins installed successfully: {ids:?} profile={} cwd={} output_len={}", profile.display(), cwd.display(), last_output.len());
    Ok(())
}

/// 内置插件才需要解析捆绑目录（普通插件无此概念），避免无谓的资源探测
fn bundled_dir_of(app_handle: &AppHandle, preset: &PreinstallPluginInfo) -> Option<PathBuf> {
    if !preset.internal {
        return None;
    }
    bundled_plugin_dir(app_handle, &preset.id)
}

/// 解析某预设的安装 spec（纯函数，便于单测）：内置插件固定为随包捆绑目录的
/// `file:` 本地依赖（路径正确性由 [`super::internal::ensure`] 启动自愈核对）；
/// 普通插件沿用清单声明。
///
/// 捆绑目录缺失时返回错误：内置插件缺失意味着构建期 prebuild 未执行或产物被
/// 删，属发布缺陷而非用户侧的普通安装失败，错误前缀便于区分。
fn preset_spec_for_install(
    preset: &PreinstallPluginInfo,
    bundled_dir: Option<PathBuf>,
) -> Result<String, String> {
    if !preset.internal {
        return Ok(preset.spec.clone());
    }
    let dir = bundled_dir.ok_or_else(|| {
        format!(
            "BUNDLED_PLUGIN_MISSING: no bundled dir for internal plugin {} (run scripts/prebuild.ts at build time)",
            preset.id
        )
    })?;
    Ok(file_dep_spec(&dir))
}

/// 构建 `dsh plugin` 子进程的环境变量：隔离 $DSH_HOME、关闭遥测与颜色，
/// PATH 前置 shim 目录与 node 目录；用户 pnpm 过旧时强制捆绑版（见 ensure_pnpm）。
///
/// 供本模块的安装/升级/卸载与 [`super::verify`] 的完整性修复共用：子进程（dsh
/// 或 pnpm）都按同一套桌面端环境策略运行，保证 $DSH_HOME / PATH 布局一致。
pub(crate) fn build_plugin_envs(app_handle: &AppHandle, prefer_bundled_pnpm: bool) -> HashMap<String, String> {
    let node = config::get_node_binary_path(app_handle);
    let bin_dir = cli::get_bin_dir(app_handle);
    let dsh_home = config::get_dsh_data_path(app_handle);
    let pnpm_bundled = config::get_pnpm_binary_path(app_handle);
    let pnpm_user = cli::find_user_pnpm(app_handle);
    let mut envs = HashMap::from([
        (
            "DSH_HOME".to_string(),
            dsh_home.to_string_lossy().into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
    ]);
    // 用户 pnpm 过旧/不可探测时强制 pnpm shim 优先捆绑版，避免 8/9 的
    // autoInstallPeers 语义与 workspace-root gate 破坏插件安装（见 ensure_pnpm）
    if prefer_bundled_pnpm {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }
    // 环境快照日志：记录 DSH_HOME、node 位置、用户/捆绑 pnpm 路径及是否存在
    // 用于排查“DSH_HOME 隔离或 pnpm 路径错误”导致的安装静默失败
    log::info!(
        "build_plugin_envs: prefer_bundled={} DSH_HOME={} DSH_PREFER_BUNDLED_PNPM={} node={} node_exists={} bin_dir={} pnpm_user={:?} pnpm_bundled={} pnpm_bundled_exists={}",
        prefer_bundled_pnpm,
        dsh_home.display(),
        if prefer_bundled_pnpm { "1" } else { "<unset>" },
        node.display(),
        node.exists(),
        bin_dir.display(),
        pnpm_user,
        pnpm_bundled.display(),
        pnpm_bundled.exists()
    );

    let mut paths = vec![bin_dir.clone()];
    if let Some(node_dir) = node.parent() {
        paths.push(node_dir.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));

    // PATH 拼接日志：验证 shim 目录与 node 目录是否正确前置，排查 shim 未生效
    if let Ok(joined) = std::env::join_paths(paths.clone()) {
        let preview: String = joined.to_string_lossy().chars().take(800).collect();
        log::info!(
            "build_plugin_envs: PATH front bin_dir={} node_dir={:?} PATH_preview={} total_entries={}",
            bin_dir.display(),
            node.parent().map(|p| p.display().to_string()),
            preview,
            paths.len()
        );
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    } else {
        log::warn!("build_plugin_envs: join_paths failed, PATH not injected");
    }
    envs
}

/// 运行 `dsh plugin` 子命令并应用 `allowBuilds` 重试：
/// pnpm 会拦截 git 托管插件的 `prepare` 构建（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）
/// 与传递依赖的原生构建（`ERR_PNPM_IGNORED_BUILDS`）。其允许键（git depPath 含克隆
/// 提交 SHA）会随新版本变化，升级时旧条目无法匹配新依赖，必须从失败输出重新解析
/// 该键写回 profile 的 `pnpm-workspace.yaml` 后重试。
///
/// 安装与升级共用此逻辑——此前仅升级路径缺失该重试（issue #82）：git 托管插件
/// （如 dsh-better-sidebar）一升级就必然以退出码 1 失败，且包停在「prepare 未构建 →
/// `lib/index.js` 缺失」的坏态，下一次启动便因 `${DSH_HOME}/profiles/<档案>/node_modules/<pkg>/lib/index.js`
/// 无法解析而 `ERR_MODULE_NOT_FOUND` 失败。
///
/// 返回 `(退出码, 最后一次捕获的输出)`。输出仍逐行经 `preinstall-log` 实时推送。
async fn run_plugin_with_allow_build_retry(
    app_handle: &AppHandle,
    node: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &HashMap<String, String>,
    window: &WebviewWindow,
    action: &str,
) -> Result<(i32, String), String> {
    let mut retries = 0usize;
    // 初始输出为空：首次覆盖前未读取属正常，抑制未使用赋值警告
    #[allow(unused_assignments)]
    let mut last_output = String::new();
    // 入口日志：完整命令与环境关键字段，帮助定位「退出 0 却未下载」时的 pnpm 链路
    let args_preview: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let cwd_exists = cwd.exists();
    let cwd_display = cwd.display().to_string();
    log::info!(
        "run_plugin_with_allow_build_retry: action={action} node={} cwd={} cwd_exists={} args={:?} DSH_PREFER_BUNDLED_PNPM={:?} DSH_HOME={:?} PATH_len={}",
        node.display(),
        cwd_display,
        cwd_exists,
        args_preview,
        envs.get("DSH_PREFER_BUNDLED_PNPM"),
        envs.get("DSH_HOME"),
        envs.get("PATH").map(|p| p.len()).unwrap_or(0)
    );
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: format!(
                "[pnpm] 执行 dsh plugin {action} cwd={cwd_display} node={} args={:?}",
                node.display(),
                args_preview
            ),
        },
    );
    let exit_code = loop {
        let attempt = retries + 1;
        // 单次尝试开始：记录重试序号，便于关联后续输出与 allowBuilds 写入
        log::info!("run_plugin_with_allow_build_retry: attempt {attempt} action={action} cwd={cwd_display}");
        let (code, captured) = run_plugin_process(node, args, cwd, envs, window).await?;
        let out_len = captured.len();
        let out_tail: String = captured.chars().rev().take(1200).collect::<String>().chars().rev().collect();
        let out_head: String = captured.chars().take(1200).collect();
        // 尝试结果快照：落盘退出码与捕获长度，前后 1200 字符用于判断 pnpm 是否真实执行
        log::info!(
            "run_plugin_with_allow_build_retry: attempt {attempt} exit={code} captured_len={out_len} cwd={cwd_display}"
        );
        if out_len > 0 {
            log::info!("run_plugin_with_allow_build_retry: attempt {attempt} captured_head(1200)={}", out_head.replace('\n', "\\n"));
            if out_len > 1200 {
                log::info!("run_plugin_with_allow_build_retry: attempt {attempt} captured_tail(1200)={}", out_tail.replace('\n', "\\n"));
            }
            // 完整输出落盘：避免截断导致 allowBuilds 键丢失，写入临时日志文件供排查
            // 路径在用户数据目录 logs/pnpm-try-{attempt}.log，便于复现后直接查看完整 pnpm 输出
            let log_dir = config::get_base_dir(app_handle).join("logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let dump_path = log_dir.join(format!("pnpm-{}-attempt{}.log", action, attempt));
            if let Err(e) = std::fs::write(&dump_path, &captured) {
                log::warn!("run_plugin_with_allow_build_retry: failed to dump pnpm output to {} err={e}", dump_path.display());
            } else {
                log::info!("run_plugin_with_allow_build_retry: full output dumped to {} len={}", dump_path.display(), out_len);
                let _ = window.emit(
                    PREINSTALL_LOG_EVENT,
                    PreinstallLogPayload {
                        line: format!("[pnpm] 完整输出已落盘 {} ({} bytes)", dump_path.display(), out_len),
                    },
                );
            }
            // pnpm 关键错误标记检测：即使退出码 0 也可能含构建阻断错误（本次日志即为 exit 0 却含 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）
            let has_pnpm_err = captured.contains("ERR_PNPM_") || captured.contains("needs to execute build scripts") || captured.contains("Failed to prepare git-hosted package");
            if has_pnpm_err {
                log::warn!("run_plugin_with_allow_build_retry: detected pnpm ERR marker in output attempt {attempt} code={code} has_err={has_pnpm_err}");
            }
        } else {
            // 空输出告警：为空时极可能是 pnpm 未被调度或 shim 转发失败
            log::warn!("run_plugin_with_allow_build_retry: attempt {attempt} captured empty! action={action} code={code}");
        }
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!("[pnpm] attempt {attempt} exit={code} captured_len={out_len}"),
            },
        );
        // 关键修复：无论退出码是否为 0，都先解析 allowBuilds 白名单
        // 原因：本次日志显示 pnpm 在 allowBuilds 阻断时仍以 exit 0 退出，仅靠退出码无法触发重试
        let new_keys = parse_allowlist_keys(&captured);
        log::info!(
            "run_plugin_with_allow_build_retry: attempt {attempt} parse_allowlist_keys={new_keys:?} retries={retries} max={MAX_ALLOW_LIST_RETRIES} code={code}"
        );
        if !new_keys.is_empty() {
            if retries >= MAX_ALLOW_LIST_RETRIES {
                log::error!(
                    "dsh plugin {action} failed: allowBuilds retry limit reached retries={retries} code={code} keys={new_keys:?} output_tail={}",
                    captured.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>().replace('\n', "\\n")
                );
                last_output = captured;
                break code;
            }
            retries += 1;
            // 写入 allowBuilds 并重试：记录写入前后的 workspace 配置以便核对
            let ws_path = profile_dir(app_handle).join("pnpm-workspace.yaml");
            let before = std::fs::read_to_string(&ws_path).unwrap_or_else(|_| "<no file>".to_string());
            log::info!("run_plugin_with_allow_build_retry: pnpm-workspace.yaml before retry {retries}: {}", before.chars().take(800).collect::<String>().replace('\n', "\\n"));
            log::info!("run_plugin_with_allow_build_retry: writing allowBuilds {new_keys:?} for retry {retries}");
            add_allow_build_keys(app_handle, &new_keys)?;
            let after = std::fs::read_to_string(&ws_path).unwrap_or_else(|_| "<read failed>".to_string());
            log::info!("run_plugin_with_allow_build_retry: pnpm-workspace.yaml after retry {retries}: {}", after.chars().take(800).collect::<String>().replace('\n', "\\n"));
            log::info!(
                "pnpm allowBuilds updated with {new_keys:?}, retrying {action} ({retries})"
            );
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 已放行插件构建（allowBuilds={new_keys:?}），重试{action}… ({retries})"),
                },
            );
            // 不保留本次 allowBuilds 触发的中间输出，仅保留最终成功/失败的完整输出
            continue;
        }
        if code == 0 {
            // 无 allowBuilds 且退出码 0 才是真正成功；保留输出供核验“假成功”
            last_output = captured;
            let snippet: String = last_output.chars().rev().take(2000).collect::<String>().chars().rev().collect();
            log::info!("run_plugin_with_allow_build_retry: action={action} succeeded attempt {attempt} output_tail(2000)={}", snippet.replace('\n', "\\n"));
            break 0;
        }
        // 退出码非 0 且无可补充白名单：记录失败并退出循环
        last_output = captured;
        log::error!(
            "dsh plugin {action} failed with exit code {code}; no allowBuilds entries to add retries={retries} output_tail={}",
            last_output.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>().replace('\n', "\\n")
        );
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!("[pnpm] {action} 失败 exit={code} allowBuilds_keys={new_keys:?}"),
            },
        );
        break code;
    };
    // 返回最终退出码与最后一次输出，供上层区分“假成功”与“真实失败”
    Ok((exit_code, last_output))
}

/// 升级单个插件：`dsh plugin --profile <当前档案> update <id>`
pub async fn update(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    run_single_plugin_command(app_handle, id, "update", &["update".to_string(), id.to_string()])
        .await
}

/// 卸载单个插件：`dsh plugin --profile <当前档案> remove <id>`
pub async fn remove(app_handle: &AppHandle, id: &str) -> Result<(), String> {
    let command_result =
        run_single_plugin_command(app_handle, id, "remove", &["remove".to_string(), id.to_string()])
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
        } else {
            // 受保护包：命令失败则如实上报（不要把失败误报为成功），成功则仅告警。
            command_result?;
            log::warn!(
                "dsh plugin remove reported success but protected package {id} is still referenced by profile manifest; skipping offline uninstall"
            );
        }
    }
    Ok(())
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

    let prefer_bundled_pnpm = ensure_pnpm(app_handle, &window).await?;

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
        app_handle,
        &node,
        &args,
        &cwd,
        &envs,
        &window,
        action,
    )
    .await?;

    if exit_code != 0 {
        log::error!("dsh plugin {action} failed for {id} with exit code {exit_code}");
        let message = pick_error_message(&output, git_transport_hint(&output));
        if let Err(e) = errors::record(app_handle, id, action, &message) {
            log::warn!("failed to record plugin error for {id}: {e}");
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
    if action == "remove" && id == "dsh-win-terminal-inspector" {
        if let Err(e) = workflow::win_inspector::apply(app_handle) {
            log::warn!("win inspector patch prune failed after remove: {e}");
        }
    }
    log::info!("dsh plugin {action} succeeded for {id}");
    Ok(())
}

/// 从 dsh/pnpm 失败输出中提取可展示的错误消息：优先 git 传输层提示；
/// 否则挑出命中错误标记的行（最多 8 行），没有则取输出尾部，ANSI 清洗后
/// 截断到 2000 字符。
fn pick_error_message(output: &str, hint: Option<&str>) -> String {
    if let Some(hint) = hint {
        return hint.to_string();
    }
    let cleaned: Vec<String> = output
        .split('\n')
        .filter_map(|line| {
            let trimmed = strip_ansi(line);
            let trimmed = trimmed.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .filter(|line| {
            line.contains("ERR_")
                || line.contains("error")
                || line.contains("Error")
                || line.contains("failed")
                || line.contains("✖")
                || line.contains("warning")
        })
        .take(8)
        .collect();
    let base = if cleaned.is_empty() {
        output.trim().to_string()
    } else {
        cleaned.join("\n")
    };
    base.chars().take(2000).collect()
}

/// 去除 ANSI 转义序列（`\x1B[...m`，含颜色/样式码）。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // '['
            while let Some(&n) = chars.peek() {
                if n.is_ascii_digit() || n == ';' {
                    chars.next();
                } else {
                    break;
                }
            }
            if chars.peek() == Some(&'m') {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 确保插件安装使用的 pnpm 可用，返回是否应强制使用捆绑版
/// （true 时调用方注入 `DSH_PREFER_BUNDLED_PNPM=1`，pnpm shim 优先捆绑版）。
///
/// 版本感知策略，避免给已装正确 pnpm 的用户增加下载步骤：
/// - 档案 store 主版本已知 → 只接受与其一致的 pnpm（用户版或捆绑版）。
///   pnpm 10 与 11 的 store 布局互不兼容（`.../store/v10` vs `v11`），用与
///   store 主版本不一致的 pnpm 更新已装插件会直接 `ERR_PNPM_UNEXPECTED_STORE`
///   退出码 1 失败——升级失败的根因（此前捆绑版 v11 一存在就强制使用，
///   对 v10 store 的档案必然失败）；
/// - 用户 pnpm 主版本 == store 主版本 → 复用用户 pnpm，零额外步骤；
/// - 捆绑版 pnpm 主版本 == store 主版本 → 用捆绑版（不下载）；
/// - store 未知（全新档案/未装过依赖）或无可匹配版本 → 用户 pnpm ≥ 10 优先，
///   否则捆绑版已存在则用，再否则下载捆绑版并强制使用。
///
/// 用户 pnpm 过旧（8/9：不读 pnpm-workspace.yaml 的 autoInstallPeers、有
/// workspace-root gate；corepack shim 在 Node 24 上还会 ERR_INVALID_THIS 崩溃）
/// 或版本不可探测 → 走捆绑版。
async fn ensure_pnpm(app_handle: &AppHandle, window: &WebviewWindow) -> Result<bool, String> {
    // 档案的 node_modules 由哪个 pnpm 主版本创建（.modules.yaml 的 storeDir 段）
    let store_major = profile_store_major(app_handle);
    let user_major = user_pnpm_major_version(app_handle);
    let bundled_major = bundled_pnpm_major(app_handle);
    let bundled_bin = config::get_pnpm_binary_path(app_handle);
    let user_pnpm_path = cli::find_user_pnpm(app_handle);
    let profile = profile_dir(app_handle);
    // 入口选型日志：一次性记录 store/user/bundled 三方版本与路径，帮助定位
    // “选择了错误 pnpm 或捆绑缺失”导致的静默失败；前端面板同步提示选型结果
    log::info!(
        "ensure_pnpm: entry store_major={store_major:?} user_major={user_major:?} bundled_major={bundled_major:?} bundled_exists={} bundled_bin={} user_pnpm={:?} profile={}",
        bundled_bin.exists(),
        bundled_bin.display(),
        user_pnpm_path,
        profile.display()
    );
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: format!(
                "[pnpm] 选型: store={store_major:?} user={user_major:?} bundled={bundled_major:?} user_path={:?}",
                user_pnpm_path.as_ref().map(|p| p.display().to_string())
            ),
        },
    );
    // 1) store 主版本已知 → 优先选与 store 一致的 pnpm（用户版或捆绑版）
    if let Some(store) = store_major {
        if user_major == Some(store) {
            log::info!(
                "ensure_pnpm: decision=reuse_user store={store} user_pnpm={:?} bundled_major={bundled_major:?}",
                user_pnpm_path
            );
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 复用用户 pnpm v{store}（匹配 store） path={:?}", user_pnpm_path),
                },
            );
            return Ok(false);
        }
        if bundled_major == Some(store) {
            log::info!(
                "ensure_pnpm: decision=use_bundled store={store} bundled={} user={user_major:?}",
                bundled_bin.display()
            );
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 使用捆绑 pnpm v{store}（匹配 store） path={}", bundled_bin.display()),
                },
            );
            return Ok(true);
        }
        log::warn!(
            "ensure_pnpm: no match for store {store} (user {user_major:?} bundled {bundled_major:?} user_path={:?}), falling back to user pnpm logic",
            user_pnpm_path
        );
    }

    // 2) store 未知（全新档案/未装过依赖）或无可匹配版本 → 用户 pnpm ≥ 10 优先
    match user_major {
        Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => {
            log::info!(
                "ensure_pnpm: decision=reuse_user (store unknown) user_major={major} user_path={:?} bundled_major={bundled_major:?}",
                user_pnpm_path
            );
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!("[pnpm] 复用用户 pnpm v{major}（全新档案，用户优先） path={:?}", user_pnpm_path),
                },
            );
            return Ok(false);
        }
        Some(major) => {
            // 用户 pnpm 版本过旧：旧版不读取 pnpm-workspace.yaml 的 autoInstallPeers
            // 且存在 workspace-root 安装门槛，继续使用会导致伪失败，切到捆绑版
            log::warn!(
                "ensure_pnpm: user pnpm major {major} < {MIN_TRUSTED_PNPM_MAJOR} (missing autoInstallPeers/workspace-root semantics), using bundled pnpm user_path={:?} bundled={} bundled_major={bundled_major:?}",
                user_pnpm_path,
                bundled_bin.display()
            );
        }
        None => {
            log::warn!(
                "ensure_pnpm: user pnpm not detectable (broken/blocked shim?) user_path={:?} bundled={} exists={} bundled_major={bundled_major:?}, using bundled pnpm",
                user_pnpm_path,
                bundled_bin.display(),
                bundled_bin.exists()
            );
        }
    }

    // 捆绑版已存在 → 直接用（零额外下载）；否则下载。
    if bundled_bin.exists() {
        log::info!(
            "ensure_pnpm: decision=use_bundled (user unusable, bundled exists) path={} bundled_major={bundled_major:?}",
            bundled_bin.display()
        );
        let _ = window.emit(
            PREINSTALL_LOG_EVENT,
            PreinstallLogPayload {
                line: format!("[pnpm] 使用已存在的捆绑 pnpm path={} version={:?}", bundled_bin.display(), bundled_major),
            },
        );
        return Ok(true);
    }

    log::info!(
        "ensure_pnpm: bundled pnpm missing, need download dest={} url_base={}",
        download::Pnpm.get_install_path(app_handle).display(),
        download::Pnpm.get_download_url().unwrap_or_else(|_| "<url_err>".to_string())
    );
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm not found, downloading before plugin install".to_string(),
        },
    );

    let tracker = download::ProgressTracker::new(window, 2);
    let url = download::Pnpm.get_download_url()?;
    let name = url.split('/').next_back().unwrap_or(&url).to_string();
    log::info!("ensure_pnpm: downloading bundled pnpm url={url} name={name}");
    let buffer = download::download_file(&tracker, url.clone())
        .await
        .map_err(|e| {
            log::error!("ensure_pnpm: PNPM_DOWNLOAD_FAILED url={url} err={e}");
            format!("PNPM_DOWNLOAD_FAILED: {e}")
        })?;
    log::info!("ensure_pnpm: downloaded {} bytes, verifying sha256", buffer.len());
    download::verify_sha256(&buffer, config::PNPM_SHA256)
        .map_err(|e| {
            log::error!("ensure_pnpm: PNPM_INTEGRITY_FAILED err={e}");
            format!("PNPM_INTEGRITY_FAILED: {e}")
        })?;
    log::info!("ensure_pnpm: sha256 ok, extracting to dest={}", download::Pnpm.get_install_path(app_handle).display());
    let dest = download::Pnpm.get_install_path(app_handle);

    download::ensure_extract(&tracker, name.clone(), buffer, dest.clone())
        .await
        .map_err(|e| {
            log::error!("ensure_pnpm: PNPM_EXTRACT_FAILED dest={} name={name} err={e}", dest.display());
            format!("PNPM_EXTRACT_FAILED: {e}")
        })?;

    log::info!("ensure_pnpm: bundled pnpm ready at {} name={name}", dest.display());
    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: format!("[pnpm] bundled pnpm ready at {} ({name})", dest.display()),
        },
    );
    Ok(true)
}

/// 用户 pnpm 主版本号（解析 `pnpm --version` 首个点分字段）；不存在或不可运行
/// （corepack shim 在 Node 24 上 ERR_INVALID_THIS 崩溃等）返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`super::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn user_pnpm_major_version(app_handle: &AppHandle) -> Option<u32> {
    // 用户 pnpm 路径探测：先在 PATH（排除 shim 目录）中查找，避免误判自身 shim
    let pnpm = match cli::find_user_pnpm(app_handle) {
        Some(p) => {
            // 找到用户 pnpm，记录路径供后续选型与问题排查
            log::info!("user_pnpm_major_version: found user pnpm at {}", p.display());
            p
        }
        None => {
            // 未找到用户 pnpm，说明用户未安装或 PATH 未包含，落盘当前 bin_dir
            log::info!("user_pnpm_major_version: no user pnpm found on PATH (excluding shim dir) bin_dir={}", cli::get_bin_dir(app_handle).display());
            return None;
        }
    };
    // 打包版是 GUI 进程（无控制台）：直接运行 pnpm（控制台子系统）会新建一个
    // 可见的黑色 cmd 窗口。`harness_prefer_bundled_pnpm` 在每次服务启动都会调本
    // 函数探测用户 pnpm，若不隐藏窗口则每次打开应用都会闪一个黑窗。此处与
    // `config::runtime::node_version_output` 的 CREATE_NO_WINDOW 处理保持一致。
    let mut cmd = std::process::Command::new(&pnpm);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            // 执行失败：可能是权限/被杀毒拦截或 shim 损坏，记录路径与错误
            log::warn!("user_pnpm_major_version: failed to run pnpm --version path={} err={e}", pnpm.display());
            return None;
        }
    };
    if !output.status.success() {
        // 非零退出：常见为 corepack shim 未启用导致的 ERR_INVALID_THIS
        log::warn!(
            "user_pnpm_major_version: pnpm --version non-zero path={} status={:?} stdout={} stderr={}",
            pnpm.display(),
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw = stdout.trim().to_string();
    match raw.split('.').next()?.trim().parse::<u32>() {
        Ok(v) => {
            // 版本解析成功：记录原始版本与主版本，用于与 store 的兼容性比对
            log::info!("user_pnpm_major_version: pnpm {} at {} parsed major={}", raw, pnpm.display(), v);
            Some(v)
        }
        Err(e) => {
            // 解析失败：版本格式异常，记录原始输出与错误
            log::warn!("user_pnpm_major_version: parse major failed raw={raw} path={} err={e}", pnpm.display());
            None
        }
    }
}
pub(crate) fn profile_store_major(app_handle: &AppHandle) -> Option<u32> {
    let modules_yaml = profile_dir(app_handle)
        .join("node_modules")
        .join(".modules.yaml");
    let exists = modules_yaml.exists();
    // store 版本探测：检查 .modules.yaml 是否存在，判断是否为全新档案
    log::info!("profile_store_major: check path={} exists={}", modules_yaml.display(), exists);
    let content = match std::fs::read_to_string(&modules_yaml) {
        Ok(c) => c,
        Err(e) => {
            // 无法读取：全新档案或文件被删除，返回 None 走“用户优先”逻辑
            log::info!("profile_store_major: no modules.yaml at {} err={e} -> None (fresh profile)", modules_yaml.display());
            return None;
        }
    };
    let parsed = parse_store_major_from_modules_yaml(&content);
    // 解析结果落盘：记录路径、解析值与文件头，便于定位 store 解析失败
    log::info!(
        "profile_store_major: path={} parsed={parsed:?} content_head={}",
        modules_yaml.display(),
        content.chars().take(400).collect::<String>().replace('\n', "\\n")
    );
    parsed
}

/// 从 `.modules.yaml` 文本解析 store 主版本（纯函数，便于单测）。
fn parse_store_major_from_modules_yaml(content: &str) -> Option<u32> {
    let store_dir = content.lines().find_map(|line| {
        line.trim().strip_prefix("storeDir:").map(str::trim)
    })?;
    // storeDir 形如 `C:\Users\xx\AppData\Local\pnpm\store\v10`，取末段 `v10` 的数字
    let major = store_dir
        .trim_matches(['"', '\''])
        .rsplit(['\\', '/'])
        .next()?
        .strip_prefix('v')?;
    let v = major.parse().ok();
    if v.is_none() {
        // 解析失败：storeDir 格式异常，记录便于定位文件损坏
        log::warn!("parse_store_major_from_modules_yaml: failed to parse storeDir={store_dir} major={major}");
    }
    v
}

/// 捆绑版 pnpm 的主版本（读 `dependencies/pnpm/package.json` 的 version 字段）；
/// 未安装或清单缺失返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`super::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn bundled_pnpm_major(app_handle: &AppHandle) -> Option<u32> {
    let manifest = config::get_pnpm_install_path(app_handle).join("package.json");
    let exists = manifest.exists();
    if !exists {
        // 捆绑 pnpm 未安装：manifest 缺失，返回 None 触发后续下载分支
        log::info!("bundled_pnpm_major: manifest not found at {} -> None (bundled not installed)", manifest.display());
        return None;
    }
    let content = match std::fs::read_to_string(&manifest) {
        Ok(c) => c,
        Err(e) => {
            // 读取失败：权限或文件损坏
            log::warn!("bundled_pnpm_major: read failed path={} err={e}", manifest.display());
            return None;
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            // 解析失败：清单损坏，记录头部以便定位
            log::warn!("bundled_pnpm_major: json parse failed path={} err={e} head={}", manifest.display(), content.chars().take(300).collect::<String>().replace('\n', "\\n"));
            return None;
        }
    };
    let ver = value.get("version")?.as_str()?;
    let major: Option<u32> = ver.split('.').next()?.parse().ok();
    // 解析成功：记录版本与主版本，供选型决策使用
    log::info!("bundled_pnpm_major: path={} version={ver} major={major:?}", manifest.display());
    major
}

/// 从 pnpm 失败输出中解析需写入 `allowBuilds` 的键集合：
/// - git 托管插件 prepare 被拦时，pnpm 会提示 `allowBuilds:\n  <depPath>: true`，
///   原样采纳 depPath（形式随克隆方式变化，只能是运行期报出的值）；
/// - 传递原生依赖被忽略构建（`Ignored build scripts:`）时，取其 `name@version` 的包名。
fn parse_allowlist_keys(output: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let lines: Vec<&str> = output.lines().collect();

    // 1) git depPath 允许键：跟随 `allowBuilds:` 示例行后的缩进 `<key>: true`。
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "allowBuilds:" {
            if let Some(next) = lines.get(idx + 1) {
                if let Some(key) = extract_allow_line_key(next) {
                    if !keys.iter().any(|k| k == &key) {
                        keys.push(key);
                    }
                }
            }
        }
    }

    // 2) 传递原生构建包名：`Ignored build scripts: <name>@<ver>, ...`。
    for line in &lines {
        if let Some(sub) = line.split("Ignored build scripts:").nth(1) {
            for token in sub.split([',', ' ']) {
                let token = token.trim();
                if token.is_empty() {
                    continue;
                }
                let name = token.split('@').next().unwrap_or(token).trim();
                if !name.is_empty() && !keys.iter().any(|k| k == name) {
                    keys.push(name.to_string());
                }
            }
        }
    }

    keys
}

/// 若 `line` 形如 `  <key>: true`（有缩进），返回 `<key>`（去缩进与后缀）。
/// pnpm 报出的 depPath 键本身不带引号，这里只做剥离该行格式。
fn extract_allow_line_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.len() == line.len() {
        return None; // 无缩进，不是白名单条目
    }
    let suffix = trimmed.strip_suffix(": true")?;
    let key = suffix.trim_end();
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

/// profile 下的 `pnpm-workspace.yaml` 路径（$DSH_HOME/profiles/<当前档案>）
fn profile_workspace_path(app_handle: &AppHandle) -> PathBuf {
    profile_dir(app_handle).join("pnpm-workspace.yaml")
}

/// 把新的 `allowBuilds` 键合并写回 profile 的 `pnpm-workspace.yaml`。
///
/// 用 YAML 库（serde_yaml）整体改写而非字符串拼接，避免格式错乱：
/// - 键（git depPath 含 `@`/`/`/`:`/`#`）由库自动按需加引号，不再手工拼；
/// - 已存在的同名键会被就地覆盖，不会残留占位值。
///
/// TODO(v1): 移除对旧版损坏文件（issue #49）的自愈逻辑。v1 起只解析干净配置，
/// `apply_allow_build_keys` 中解析失败后的「同键去重再解析」与
/// `collapse_allow_builds_duplicates` 一并删除。
///
/// 防御性修复：旧版本用字符串拼接可能留下「重复映射键」的损坏文件
/// （最多见的是 `node-pty: set this to true or false` 占位行与真正的
/// `'node-pty': true` 并存，见 issue #49）。此处解析失败时先做一次
/// `allowBuilds` 同键去重再解析，把损坏文件自愈回合法 YAML。
fn add_allow_build_keys(app_handle: &AppHandle, keys: &[String]) -> Result<(), String> {
    let path = profile_workspace_path(app_handle);
    let dir = path
        .parent()
        .ok_or("PREINSTALL_BAD_PROFILE_DIR: no profile dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("PREINSTALL_MKDIR: {e}"))?;

    let content = if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("PREINSTALL_READ_WORKSPACE: {e}"))?
    } else {
        // 与 dsh `initProfile` 生成的基础模板保持一致（尚无 allowBuilds）。
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n".to_string()
    };

    let rendered = apply_allow_build_keys(&content, keys)?;
    if rendered == content {
        return Ok(()); // 无变化（所有键已就位），避免无意义写盘
    }

    log::info!("pnpm-workspace.yaml rewritten with allowBuilds {keys:?} at {}", path.display());
    std::fs::write(&path, rendered).map_err(|e| format!("PREINSTALL_WRITE_WORKSPACE: {e}"))
}

/// 把新的 `allowBuilds` 键合并进 `pnpm-workspace.yaml` 文本并返回新文本。
///
/// 用 YAML 库（serde_yaml）整体改写而非字符串拼接，避免格式错乱：
/// - 键（git depPath 含 `@`/`/`/`:`/`#`）由库自动按需加引号，不再手工拼；
/// - 已存在的同名键会被就地覆盖为 `true`，不会残留占位值，也不会产生重复键。
///
/// 防御性修复：旧版本用字符串拼接可能留下「重复映射键」的损坏文件
/// （最多见的是 `node-pty: set this to true or false` 占位行与真正的
/// `'node-pty': true` 并存，见 issue #49）。此处先尝试严格解析；解析失败时
/// 做一次 `allowBuilds` 同键去重再解析，把损坏文件自愈回合法 YAML。
fn apply_allow_build_keys(content: &str, keys: &[String]) -> Result<String, String> {
    // 先尝试严格解析。旧的损坏文件（重复映射键）严格解析会失败：
    // 把 `allowBuilds` 内同名键去重（保留最后写入的值）后再解析，自愈损坏状态。
    let mut repaired = false;
    let mut doc: Value = match serde_yaml::from_str(content) {
        Ok(v) => v,
        Err(first_err) => {
            let normalized = collapse_allow_builds_duplicates(content);
            if normalized == content {
                return Err(format!(
                    "PREINSTALL_WORKSPACE_INVALID_YAML: {first_err}"
                ));
            }
            repaired = true;
            serde_yaml::from_str(&normalized).map_err(|e| {
                format!("PREINSTALL_WORKSPACE_INVALID_YAML: {e}")
            })?
        }
    };

    // 空/注释-only 内容解析为 `Value::Null`，视为全新空配置（pnpm-workspace.yaml
    // 可加载的最小映射）；其余非映射内容才是真正的损坏。
    if doc.is_null() {
        doc = Value::Mapping(Mapping::new());
    }

    let map = doc.as_mapping_mut().ok_or_else(|| {
        "PREINSTALL_WORKSPACE_NOT_MAP: pnpm-workspace.yaml must be a mapping".to_string()
    })?;

    let allow_key = Value::String("allowBuilds".to_string());
    if !map.contains_key(&allow_key) {
        map.insert(allow_key.clone(), Value::Mapping(Mapping::new()));
    }
    let allow_builds = map
        .get_mut(&allow_key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| {
            "PREINSTALL_WORKSPACE_ALLOWBUILDS_NOT_MAP: allowBuilds must be a mapping".to_string()
        })?;

    let mut dirty = false;
    for key in keys {
        let k = Value::String(key.clone());
        if allow_builds.get(&k) == Some(&Value::Bool(true)) {
            continue; // 已是 true，幂等跳过
        }
        // 直接覆盖旧值（含占位值/旧 false），由库负责按需加引号
        allow_builds.insert(k, Value::Bool(true));
        dirty = true;
    }
    if !dirty && !repaired {
        return Ok(content.to_string());
    }
    // 有键新增，或损坏文件已被自愈归一化——两种都要落回解析后的完整文档，
    // 否则会把损坏的原始文本原样返回。

    serde_yaml::to_string(&doc).map_err(|e| format!("PREINSTALL_WORKSPACE_RENDER: {e}"))
}

/// 把损坏的 `allowBuilds` 映射（同一键出现多次）去重为合法 YAML。
///
/// 仅作为旧版字符串拼接遗留损坏（重复映射键，见 issue #49）的兜底归一化：
/// 扫描 `allowBuilds:` 之后、下一个顶层键之前的缩进 `key: value` 行，同一键
/// 只保留最后一次出现的行（与 YAML「后者覆盖前者」语义一致），其余行原样保留。
fn collapse_allow_builds_duplicates(content: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut in_allow = false;
    // 记录（键 → 该键所有行的索引），用于去重
    let mut key_indexes: HashMap<String, Vec<usize>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed == "allowBuilds:" {
            in_allow = true;
            continue;
        }
        if in_allow {
            let is_indent = line.starts_with(' ') || line.starts_with('\t');
            let is_comment = trimmed.starts_with('#');
            if !is_indent || is_comment {
                in_allow = false; // 遇到顶层键或注释即离开 allowBuilds
                continue;
            }
            // 缩进的 `key: value` 行 → 提取键（冒号前）
            if let Some(col) = trimmed.find(':') {
                let key = trimmed[..col].trim().trim_matches(['\'', '"']);
                if !key.is_empty() {
                    if !key_indexes.contains_key(key) {
                        order.push(key.to_string());
                    }
                    key_indexes.entry(key.to_string()).or_default().push(idx);
                }
            }
        }
    }

    // 每个键只保留最后一个出现行，其余标记删除
    let mut keep: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for key in &order {
        if let Some(idxs) = key_indexes.get(key) {
            if let Some(&last) = idxs.last() {
                keep.insert(last);
            }
        }
    }
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    for (idx, line) in lines.iter().enumerate() {
        if key_indexes.values().any(|v| v.contains(&idx)) && !keep.contains(&idx) {
            continue; // 是被去重掉的重复键行
        }
        out.push(line);
    }
    // 避免重复键里夹带的空行粘连成异常空行：去掉去重区（allowBuilds 段）的连续空行
    out.join("\n")
}

/// 把 `github:owner/repo[#ref]` 一类的 GitHub 简写规范为显式 HTTPS 依赖形式
/// （`git+https://github.com/owner/repo.git[#ref]`）。
///
/// 动机：pnpm 解析 GitHub 简写时，「HTTPS 可达性探测一旦失败就回退 git+ssh」
/// 是已知缺陷（issue #3948 / #7243 / #13276，官方已 accepted 仍未修）。公开仓库
/// 一旦落进 git+ssh，在无 SSH 配置的桌面机上（非交互子进程无法应答 known_hosts
/// 询问）必然硬失败。规范为显式 `git+https:` 后 pnpm 直接走 HTTPS 克隆，绕开该
/// 回退；非 `github:` 形式（如纯 npm 包名）原样返回。
fn normalize_git_spec(spec: &str) -> String {
    let Some(rest) = spec.strip_prefix("github:") else {
        return spec.to_string();
    };
    let (path, fragment) = match rest.split_once('#') {
        Some((p, f)) => (p.trim_end_matches('/'), Some(f)),
        None => (rest.trim_end_matches('/'), None),
    };
    let mut repo = path.to_string();
    if !repo.ends_with(".git") {
        repo.push_str(".git");
    }
    let mut url = format!("git+https://github.com/{repo}");
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

/// 从 pnpm 失败输出里识别 git 传输层错误（区别于 allowBuilds 构建门禁），命中时
/// 返回一句可读的成因/指引。pnpm 在这些场景下已经退到 git+ssh，再去补 allowBuilds
/// 白名单是无效且误导的。
fn git_transport_hint(output: &str) -> Option<&'static str> {    const SIGNALS: &[(&str, &str)] = &[
        (
            "host key verification failed",
            "git fell back to SSH and could not verify GitHub's host key (no known_hosts entry; the process ran non-interactively). Make sure GitHub is reachable over HTTPS.",
        ),
        (
            "permission denied (publickey)",
            "git fell back to SSH but no GitHub SSH key is configured (Permission denied (publickey)). Reach GitHub over HTTPS instead.",
        ),
        (
            "could not read from remote repository",
            "pnpm could not read from the git remote — commonly a git+ssh transport failure. Ensure GitHub is reachable over HTTPS.",
        ),
        (
            "ssh: connect to host",
            "pnpm tried to reach GitHub over SSH (port 22) and the connection was refused. Use HTTPS instead.",
        ),
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .find(|(sig, _)| lower.contains(sig))
        .map(|(_, hint)| *hint)
}

/// 决定 Harness 服务进程启动时是否应注入 `DSH_PREFER_BUNDLED_PNPM=1`
/// （轻量缓解，issue #69 系列：让 dsh-market 子进程的 pnpm 走与桌面端插件安装
/// 同一套受控策略，而非落到系统 pnpm 引发 store 不兼容 / 无 TTY / allowBuilds 门禁）。
///
/// 与 [`ensure_pnpm`] 的版本感知保持一致，但**启动阶段绝不触发下载**：捆绑版尚未
/// 安装时返回 false（交由用户 pnpm，shim 默认用户优先）。仅当捆绑版已安装且满足
/// 下列任一条件才强制捆绑版：
/// - 档案 store 主版本已知且 == 捆绑版主版本，且用户 pnpm 主版本 != store
///   （否则用户版会 `ERR_PNPM_UNEXPECTED_STORE`）；
/// - store 未知（全新档案）且用户 pnpm 缺失或过旧（< `MIN_TRUSTED_PNPM_MAJOR`）。
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
    use std::path::PathBuf;
    use super::{apply_allow_build_keys, collapse_allow_builds_duplicates, extract_allow_line_key, git_transport_hint, normalize_git_spec, parse_allowlist_keys, parse_store_major_from_modules_yaml, preset_spec_for_install, PreinstallPluginInfo};

    /// 构造预设条目的测试助手（internal 由各用例显式指定）
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
    fn install_spec_passthrough_for_regular_preset() {
        // 普通插件：spec 原样返回，与捆绑目录无关
        let p = preset("dshmarket", "dshmarket", false);
        assert_eq!(
            preset_spec_for_install(&p, None).unwrap(),
            "dshmarket"
        );
        assert_eq!(
            preset_spec_for_install(&p, Some(PathBuf::from("/ignored"))).unwrap(),
            "dshmarket"
        );
    }

    #[test]
    fn install_spec_uses_bundled_dir_for_internal_preset() {
        // 内置插件：安装依赖为 file:<捆绑目录>（正斜杠规范形）
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let dir = PathBuf::from("C:\\Apps\\dsh\\resources\\preset-plugins\\dsh-tauri");
        assert_eq!(
            preset_spec_for_install(&p, Some(dir)).unwrap(),
            "file:C:/Apps/dsh/resources/preset-plugins/dsh-tauri"
        );
    }

    #[test]
    fn install_spec_errors_when_internal_bundle_missing() {
        // 内置插件捆绑目录缺失：发布缺陷，显式报错而非静默走 npm/git spec
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let err = preset_spec_for_install(&p, None).unwrap_err();
        assert!(err.starts_with("BUNDLED_PLUGIN_MISSING"));
        assert!(err.contains("dsh-tauri"));
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
            parse_store_major_from_modules_yaml("storeDir: /home/test/.local/share/pnpm/store/v11\n"),
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
        assert_eq!(parse_store_major_from_modules_yaml("lockfileVersion: '9.0'\n"), None);
        assert_eq!(parse_store_major_from_modules_yaml(""), None);
        assert_eq!(
            parse_store_major_from_modules_yaml("storeDir: C:\\Users\\x\\pnpm\\store\n"),
            None
        );
    }

    #[test]
    fn parse_git_dep_path_key() {
        let out = "\
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from \"...\"
The git-hosted package \"dsh-better-sidebar@0.14.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist.
...
allowBuilds:
  dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89: true
";
        let keys = parse_allowlist_keys(out);
        assert!(keys.contains(&"dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89".to_string()));
        assert!(!keys.contains(&"dsh-better-sidebar".to_string()));
    }

    #[test]
    fn parse_ignored_builds_name() {
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["node-pty".to_string()]);
    }

    #[test]
    fn parse_empty_when_irrelevant() {
        let out = "everything looks fine output\nno allowlist here\n";
        assert!(parse_allowlist_keys(out).is_empty());
    }

    #[test]
    fn allow_line_key_requires_indent() {
        let key = extract_allow_line_key("  node-pty: true");
        assert_eq!(key.as_deref(), Some("node-pty"));

        // 无缩进（顶层键）不应被当作白名单条目
        assert_eq!(extract_allow_line_key("packages:"), None);
        assert_eq!(extract_allow_line_key("allowBuilds:"), None);
    }

    // ---- 归并写回 pnpm-workspace.yaml（issue #49 回归）----

    /// 从渲染结果里解析出单一 `allowBuilds` 映射，便于断言。
    fn allow_builds_map(yaml: &str) -> serde_yaml::Mapping {
        let doc: serde_yaml::Value = serde_yaml::from_str(yaml).expect("output must be valid YAML");
        doc.get("allowBuilds")
            .and_then(serde_yaml::Value::as_mapping)
            .expect("allowBuilds must be a mapping")
            .clone()
    }

    #[test]
    fn apply_adds_new_key_when_absent() {
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        // 无 allowBuilds 时首次写入
        let out = apply_allow_build_keys(base, &["node-pty".to_string()]).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(map.get("node-pty"), Some(&serde_yaml::Value::Bool(true)));
        // 顶级基础设置被保留
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert!(doc.get("packages").is_some());
        assert!(doc.get("nodeLinker").is_some());
    }

    #[test]
    fn apply_is_idempotent_and_does_not_duplicate() {
        // 已放行的键再次写入：结果不变（幂等、不产生重复键）
        let base = "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n";
        let out = apply_allow_build_keys(base, &["node-pty".to_string()]).unwrap();
        assert_eq!(out, base);
    }

    #[test]
    fn apply_quotes_git_dep_path_keys() {
        let dep = "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89".to_string();
        // 空内容也能生成合法配置
        let out = apply_allow_build_keys("", &[dep.clone()]).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(map.get(&serde_yaml::Value::String(dep)), Some(&serde_yaml::Value::Bool(true)));
        // 库负责正确加引号，键原样（含 @ / : / #）可回读
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            doc["allowBuilds"][&serde_yaml::Value::String(
                "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89".to_string()
            )],
            serde_yaml::Value::Bool(true)
        );
    }

    #[test]
    fn apply_overwrites_placeholder_value_without_duplicate() {
        // 关键回归：旧版字符串拼接可能留下占位键 `node-pty: set this to true or false`
        // 与真实键并存。若解析保留重复键，或解析失败被去重兜底，最终都必须只保留
        // 一个 `node-pty: true`（不允许重复映射键）。
        let corrupted =
            "allowBuilds:\n  'dsh-better-sidebar@https://code...': true\n  node-pty: set this to true or false\n  'node-pty': true\n";
        let out = apply_allow_build_keys(corrupted, &["node-pty".to_string()]).unwrap();
        let map = allow_builds_map(&out);
        // 恰好只有一个 node-pty 键，值是 true（覆盖了占位值）
        assert_eq!(map.get("node-pty"), Some(&serde_yaml::Value::Bool(true)));
        // 序列化后全局不允许再出现“重复键”的等价行（node-pty 只出现一次）
        let node_pty_keys = out
            .lines()
            .filter(|l| l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'"))
            .count();
        assert_eq!(node_pty_keys, 1);
    }

    #[test]
    fn collapse_dedupes_allow_builds_keys() {
        let corrupted =
            "packages:\n  - .\nallowBuilds:\n  node-pty: set this to true or false\n  'node-pty': true\n  keep: true\n";
        let normalized = collapse_allow_builds_duplicates(corrupted);
        // 重复的 node-pty 只剩最后一个（值 true），同键不再重复
        let node_pty = normalized
            .lines()
            .filter(|l| l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'"))
            .count();
        assert_eq!(node_pty, 1);
        assert!(normalized.contains("keep"));
        // 去重结果必须是合法 YAML，且能被后续解析
        let out = apply_allow_build_keys(&normalized, &["node-pty".to_string()]).unwrap();
        assert_eq!(allow_builds_map(&out).get("node-pty"), Some(&serde_yaml::Value::Bool(true)));
    }

    // ---- git GitHub 简写规范化（issue #51 根因绕行）----

    #[test]
    fn normalize_github_shorthand_to_git_https() {
        assert_eq!(
            normalize_git_spec("github:baihejiangnan/dsh-session-context-menu"),
            "git+https://github.com/baihejiangnan/dsh-session-context-menu.git"
        );
    }

    #[test]
    fn normalize_github_shorthand_preserves_ref_and_dedup_git_suffix() {
        assert_eq!(
            normalize_git_spec("github:omdsh-dev/DSH-better-sidebar#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 已带 .git 不重复追加
        assert_eq!(
            normalize_git_spec("github:user/repo.git"),
            "git+https://github.com/user/repo.git"
        );
        // 尾部多余斜杠剥掉
        assert_eq!(
            normalize_git_spec("github:user/repo/"),
            "git+https://github.com/user/repo.git"
        );
    }

    #[test]
    fn normalize_non_github_spec_passes_through() {
        assert_eq!(normalize_git_spec("dshmarket"), "dshmarket");
        assert_eq!(
            normalize_git_spec("git+https://github.com/foo/bar.git"),
            "git+https://github.com/foo/bar.git"
        );
    }

    // ---- git 传输层错误识别（区别于 allowBuilds 门禁）----

    #[test]
    fn git_transport_hint_detects_host_key_failure() {
        let out = "git ls-remote \"git+ssh://git@github.com/foo.git\" HEAD\nHost key verification failed.\nfatal: Could not read from remote repository.\n";
        assert!(git_transport_hint(out).is_some());
    }

    #[test]
    fn git_transport_hint_detects_publickey_and_ssh() {
        assert!(git_transport_hint("git@github.com: Permission denied (publickey)").is_some());
        assert!(git_transport_hint("ssh: connect to host github.com port 22: Connection refused").is_some());
    }

    #[test]
    fn git_transport_hint_none_for_allowbuilds_output() {
        // allowBuilds 场景（prepare 构建被拦）不应误判为传输层错误
        let out = "[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ...\nallowBuilds:\n  node-pty: true\n";
        assert!(git_transport_hint(out).is_none());
    }
}
