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
//! 读取，见 [`parse_allowlist_keys`] 与 [`apply_allow_build_keys`]）：
//! - pnpm 10（旧 store 复用用户版）只认 `onlyBuiltDependencies`（list 形式）；
//! - pnpm 11（捆绑版）认 `allowBuilds`（map 形式）。
//! 应用会把同一批包名同时写入这两个键，保证任一版本 pnpm 都能读到放行项。
//!
//! 关键陷阱：pnpm v11 在 `allowBuilds` 阻断时可能仍以 **exit 0** 退出（假成功），
//! 所以重试逻辑不能只看退出码（见 [`run_plugin_with_allow_build_retry`]），安装成功
//! 后还会核验 `node_modules` 产物是否真实落盘（见 [`verify_installed_products`]）。

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::download;
use crate::service::download::Installable;
use crate::service::profile::active_profile;
use crate::service::workflow;
use serde_yaml::{Mapping, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::errors;
use super::installed::{installed_name, is_installed, profile_dir};
use super::output;
use super::preset::{bundled_dep_spec, bundled_plugin_dir, load_presets, PreinstallPluginInfo};
use super::process::{
    acquire_operation_lock, acquire_process_lock, new_process_owner, run_plugin_process, PidGuard,
    PreinstallLogPayload, ProcessOwner, PREINSTALL_LOG_EVENT,
};
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
const PNPM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PNPM_PROBE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const PNPM_PROBE_REAP_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const PNPM_PROBE_REAP_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);
const PNPM_PROBE_LIVENESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// 校验并安装选中的预装插件：`dsh plugin --profile <当前档案> add <ids...>`
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
            return Err(format!("NETWORK_ERROR: {network_hint}"));
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
    Ok(bundled_dep_spec(&dir))
}

/// 校验本次安装是否真正落盘（防「假成功」）：pnpm v11 在 `allowBuilds` 阻断
/// git 托管插件 / 传递依赖构建时仍可能以 exit 0 退出，仅凭退出码不足以认定安装
/// 成功。此处逐插件核验 profile 的 `node_modules/<安装名>/package.json` 是否真实
/// 存在：缺失者记录错误并整体返回 Err，避免前端误报「已安装 N 个插件」。
///
/// 已落盘的插件同步清除其历史错误；`ids` 里未匹配到预设的条目忽略（调用处已先
/// 校验过 ID，正常不可达）。同时接收全部命令输出，以便静默失败时保留早期重试的
/// 诊断，而不是因最后一次重试无输出而误报「子进程完全无输出」。
fn verify_installed_products(
    app_handle: &AppHandle,
    ids: &[String],
    preset_map: &HashMap<&str, &PreinstallPluginInfo>,
    command_output: &str,
) -> Result<(), String> {
    let node_modules = profile_dir(app_handle).join("node_modules");
    let mut missing = Vec::new();
    for id in ids {
        let Some(preset) = preset_map.get(id.as_str()) else {
            continue;
        };
        let name = installed_name(preset);
        let manifest = node_modules.join(name).join("package.json");
        if manifest.is_file() {
            if let Err(e) = errors::clear(app_handle, id) {
                log::warn!("failed to clear plugin error for {id}: {e}");
            }
        } else {
            missing.push((id.clone(), manifest));
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    let detail = silent_install_failure_detail(&missing, command_output);
    log::error!("{detail}");
    for (id, _) in &missing {
        if let Err(e) = errors::record(app_handle, id, "install", &detail) {
            log::warn!("failed to record plugin error for {id}: {e}");
        }
    }
    Err(detail)
}

/// 为 exit 0 但无落盘产物的假成功生成可操作诊断：明确缺失插件、预期清单路径，
/// 并区分「子进程完全无输出」与「有输出但仍未落盘」，方便日志反馈直接定位。
fn silent_install_failure_detail(missing: &[(String, PathBuf)], command_output: &str) -> String {
    let ids = missing
        .iter()
        .map(|(id, _)| id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let manifests = missing
        .iter()
        .map(|(_, path)| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let output_hint = if command_output.trim().is_empty() {
        "The dsh plugin command produced no output."
    } else {
        "Review the preinstall log above for the command output."
    };
    format!(
        "PREINSTALL_SILENT_FAIL: dsh plugin exited with code 0, but no install artifact was created for [{ids}]. Expected package manifests: [{manifests}]. {output_hint} Retry the installation; if it repeats, include the preinstall log and these paths in the bug report."
    )
}

/// 构建 `dsh plugin` 子进程的环境变量：隔离 $DSH_HOME、关闭遥测与颜色、
/// 注入预检解析出的 node 路径（`DSH_NODE`，shim 优先采用，见 shim.rs）、
/// PATH 前置 shim、node 与桌面端自动配置的 Git 目录；用户 pnpm 过旧时强制
/// 捆绑版（见 ensure_pnpm）。
///
/// 供本模块的安装/升级/卸载与 [`super::verify`] 的完整性修复共用：子进程（dsh
/// 或 pnpm）都按同一套桌面端环境策略运行，保证 $DSH_HOME / PATH 布局一致。
pub(crate) fn build_plugin_envs(
    app_handle: &AppHandle,
    prefer_bundled_pnpm: bool,
) -> HashMap<String, String> {
    let node = config::get_node_binary_path(app_handle);
    // 规范化为绝对路径：get_node_binary_path 可能返回相对路径（PATH 上出现
    // 相对条目时，如 `.` 或 `tools\node`），而子进程 CWD 与应用进程不同，
    // 相对路径会被解析到错误位置——shim 经 DSH_NODE / PATH 都找不到 node
    // （issue #121 的 "Node.js runtime not found"）。已存在（预检通过）的
    // node 可安全 canonicalize；失败时回退原值。
    let node_abs = dunce::canonicalize(&node).unwrap_or_else(|_| node.clone());
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut explicit = HashMap::from([
        (
            "DSH_HOME".to_string(),
            config::get_dsh_data_path(app_handle)
                .to_string_lossy()
                .into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
        // 把预检解析出的 node 路径显式交给 pnpm/dsh shim（DSH_NODE 优先）：
        // shim 自身经 PATH 解析 node 可能与应用预检不一致（PATH 上的相对条目、
        // junction/符号链接、或子进程 PATH 布局差异），导致 pnpm shim 报
        // "Node.js runtime not found" 而应用预检却通过（issue #121）。
        (
            "DSH_NODE".to_string(),
            node_abs.to_string_lossy().into_owned(),
        ),
    ]);
    // 用户 pnpm 过旧/不可探测时强制 pnpm shim 优先捆绑版，避免 8/9 的
    // autoInstallPeers 语义与 workspace-root gate 破坏插件安装（见 ensure_pnpm）
    if prefer_bundled_pnpm {
        explicit.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    } else if let Some(pnpm) = cli::find_user_pnpm(app_handle) {
        // 显式注入绝对路径，避免子进程在不同 PATH/CWD 下重新发现失败。
        // Unix 保留 mise 依赖 argv[0] 的 shim 链接；Windows 仍解析连接点并剥离
        // `\\?\`。同时防御性排除应用自身 shim，避免递归调用。
        if let Some(pnpm_value) = cli::pnpm_env_value(&pnpm, &bin_dir) {
            explicit.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    let safe = crate::service::env::safe_environment();
    let existing_path = safe
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.as_str())
        .unwrap_or("");
    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node_abs.parent() {
        paths.push(node_dir.to_path_buf());
    }
    // pnpm 安装 github:/git+ssh: 插件时会直接调用 git。Windows 空白环境使用
    // 桌面端已校验安装的 MinGit，仅对子进程 PATH 生效，不污染用户系统 PATH。
    if let Some(git_dir) = config::get_git_cmd_dir(app_handle) {
        paths.push(git_dir);
    }
    paths.extend(std::env::split_paths(existing_path));

    if let Ok(joined) = std::env::join_paths(paths) {
        explicit.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }
    let mut envs = crate::service::env::environment_with_explicit(&explicit);
    // 用户 git 配置若把 GitHub HTTPS 改写为 SSH（url.<base>.insteadOf），pnpm 的
    // git 传输会落进 SSH 而硬失败；按需隔离子进程 git 配置强制 HTTPS
    // （见 [`git_https_isolation_env`]，未命中改写规则时返回空 map，零影响）。
    envs.extend(git_https_isolation_env(app_handle));
    envs
}

/// 检测用户 git 配置中「把 GitHub HTTPS 改写为 SSH」的 `url.<base>.insteadOf`
/// 规则，命中时返回隔离子进程 git 配置所需的环境变量，强制插件安装走 HTTPS。
///
/// 背景：不少用户按 GitHub 官方文档配置过
/// `git config --global url."git@github.com:".insteadOf "https://github.com/"`
/// 让个人 git 操作走 SSH。pnpm 解析 `git+https://github.com/...` 插件时同样调用
/// git，URL 被该规则改写后实际走 SSH；桌面机通常没有 SSH 密钥（非交互子进程也
/// 无法应答 known_hosts 询问），于是 `Permission denied (publickey)` /
/// `Host key verification failed` 硬失败（用户可见提示见 [`git_transport_hint`]）。
/// 检测到该类规则后，把子进程的 git 配置隔离为空文件（`GIT_CONFIG_GLOBAL`）或
/// 关闭系统配置（`GIT_CONFIG_NOSYSTEM`），让 HTTPS 地址原样生效——公开仓库无需
/// 任何凭据即可克隆。
///
/// 未命中时返回空 map：普通用户（含只配代理/凭据助手、无 SSH 改写者）的子进程
/// git 配置原样保留，零影响。探测全部为最佳努力——git 缺失、命令失败或输出异常
/// 都视为「无需隔离」，不阻断安装。
///
/// 仅用于桌面端驱动的 `dsh plugin` 子进程（`build_plugin_envs`）：不注入长驻服务
/// 进程的环境——那里会被 agent 子进程继承，隔离 git 配置会让 agent 的 git 操作
/// 丢失 user.name/凭据助手/代理等用户配置。
fn git_https_isolation_env(app_handle: &AppHandle) -> HashMap<String, String> {
    let Some(git) = plugin_git_binary(app_handle) else {
        return HashMap::new();
    };
    let mut envs = HashMap::new();
    if git_scope_has_github_ssh_rewrite(&git, &["--global"]) {
        if let Some(config) = empty_git_config_file() {
            log::info!(
                "git config rewrites GitHub HTTPS to SSH (global); isolating GIT_CONFIG_GLOBAL to force HTTPS"
            );
            envs.insert(
                "GIT_CONFIG_GLOBAL".to_string(),
                config.to_string_lossy().into_owned(),
            );
        }
    }
    if git_scope_has_github_ssh_rewrite(&git, &["--system"]) {
        log::info!(
            "git config rewrites GitHub HTTPS to SSH (system); disabling system git config to force HTTPS"
        );
        envs.insert("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string());
    }
    envs
}

/// 解析插件子进程将使用的 git 可执行文件：Windows 用桌面端已选 Git（系统 Git 或
/// 捆绑 MinGit，见 [`config::get_git_cmd_dir`]，与注入子进程 PATH 的目录一致），
/// Unix 直接用 PATH 上的 `git`。
fn plugin_git_binary(app_handle: &AppHandle) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        config::get_git_cmd_dir(app_handle).map(|dir| dir.join("git.exe"))
    }
    #[cfg(not(windows))]
    {
        Some(PathBuf::from("git"))
    }
}

/// 运行 `git config <scope> --get-regexp '^url\.'`，判断该作用域的配置里是否存在
/// 把 GitHub HTTP(S) 改写为 SSH 的 insteadOf 规则。无匹配（git 返回 1）或命令
/// 失败都视为不存在。
fn git_scope_has_github_ssh_rewrite(git: &Path, scope: &[&str]) -> bool {
    let mut cmd = std::process::Command::new(git);
    cmd.args(scope).args(["--get-regexp", "^url\\."]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 进程下禁止闪现控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(output) = cmd.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    has_github_ssh_rewrite_in_output(&String::from_utf8_lossy(&output.stdout))
}

/// 从 `git config --get-regexp '^url\.'` 的输出文本中判定是否存在把 GitHub
/// HTTP(S) 改写为 SSH 的规则（纯函数，便于单测）。
fn has_github_ssh_rewrite_in_output(output: &str) -> bool {
    output.lines().any(rewrite_rule_targets_ssh_github)
}

/// 判定单条 `url.<base>.insteadOf <value>` 输出行是否为「把 GitHub HTTP(S) 地址
/// 改写为 SSH」的有害规则。git 会把 section/key 名小写化（实际形如
/// `url.git@github.com:.insteadof`），subsection 与 value 大小写保留；
/// pushInsteadOf（`.pushinsteadof`）不会命中 `.insteadof` 后缀剥离，天然排除
/// （只影响 push，不影响拉取）。
fn rewrite_rule_targets_ssh_github(line: &str) -> bool {
    let mut parts = line.splitn(2, ' ');
    let (key, value) = match (parts.next(), parts.next()) {
        (Some(k), Some(v)) => (k.to_ascii_lowercase(), v.trim()),
        _ => return false,
    };
    let Some(base) = key
        .strip_prefix("url.")
        .and_then(|k| k.strip_suffix(".insteadof"))
    else {
        return false;
    };
    let ssh_base = base.starts_with("git@")
        || base.starts_with("ssh://")
        || base.starts_with("git+ssh://");
    ssh_base && github_http_host(value)
}

/// value 是否为 GitHub 的 HTTP(S) URL 前缀（如 `https://github.com/`、
/// `https://github.com`、`http://github.com/`）。
fn github_http_host(value: &str) -> bool {
    let value = value.trim();
    let scheme_end = value.find("://").map(|i| i + 3).unwrap_or(0);
    let host = value[scheme_end..]
        .split('/')
        .next()
        .unwrap_or(&value[scheme_end..]);
    host == "github.com" || host == "www.github.com"
}

/// 在系统临时目录创建一个空配置文件，作为隔离后的 `GIT_CONFIG_GLOBAL`。
/// 文件名带进程号与纳秒时间戳防碰撞（0 字节文件由 OS 临时目录回收，无需主动
/// 清理；GIT_CONFIG_GLOBAL 语义为「仅读取该文件」，空文件即无任何全局配置）。
fn empty_git_config_file() -> Option<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "dsh-gitconfig-{}-{nanos:x}.empty",
        std::process::id()
    ));
    std::fs::write(&path, "").ok()?;
    Some(path)
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
/// 返回 `(退出码, 所有尝试累积的有界尾部输出)`，避免最后一次重试无输出时丢失
/// 此前诊断，同时防止重试次数放大内存占用。输出仍逐行经 `preinstall-log` 实时推送。
///
/// 注意：pnpm v11 在 `allowBuilds` 将 git 托管插件（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）
/// 或传递依赖（`ERR_PNPM_IGNORED_BUILDS`）拦截时仍可能以 **exit 0** 退出（假成功），
/// 因此不能仅凭退出码判断成败——必须先解析输出里的 `allowBuilds` 键，有键就写入
/// profile 的 `pnpm-workspace.yaml` 并重试。无键可加（或到达重试上限）才以本次退出码为准。
///
/// 每次重试的输出都必须累积，避免最终尝试无输出时覆盖此前真正有用的 pnpm 诊断。
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
fn append_command_output(all_output: &mut String, captured: &str) {
    if captured.is_empty() {
        return;
    }
    if !all_output.is_empty() && !all_output.ends_with('\n') {
        output::append_bounded_string(all_output, "\n");
    }
    output::append_bounded_string(all_output, captured);
}

/// 升级单个插件：`dsh plugin --profile <当前档案> update <id>`
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

/// 计算需要自动卸载的弃用插件已安装包名（纯函数，便于单测）。
///
/// 命中条件：清单中带 `deprecated` 标记、非内部插件（内部插件由启动自愈强制
/// 安装，不适用弃用语义），且当前已安装（以实际 npm 包名 `installed_name` 为准）。
/// 返回实际安装包名——离线卸载（`uninstall_recovery`）以它为键从 profile 清单与
/// `node_modules` 精准移除（scoped 包名与预设 id 不一致时也能正确卸载）。
fn deprecated_installed_names(
    presets: &[PreinstallPluginInfo],
    installed: impl Fn(&str) -> bool,
) -> Vec<String> {
    presets
        .iter()
        .filter(|p| p.deprecated && !p.internal)
        .filter(|p| installed(installed_name(p)))
        .map(|p| installed_name(p).to_string())
        .collect()
}

/// 启动时自动卸载清单中带 `deprecated` 标记的插件。
///
/// 弃用是发布侧决策：某个社区插件下架/被替换后，在 `preset-plugins.json` 里给它
/// 打上 `deprecated` 标记，桌面端每次启动核对「已安装 → 自动卸载」，无需用户手动
/// 处理，也避免残留插件继续在 profile 里加载破坏启动。仅处理社区预设；未被引用
/// 的条目跳过。已卸载/未安装的插件跳过，绝不误伤其它插件。
///
/// 启动阶段走离线精准卸载（`uninstall_recovery`）：不依赖 node/pnpm/窗口，即使
/// 插件产物已损坏也能移除，也不会触发服务停止或 pnpm 下载。最佳努力：任何失败
/// 只记告警，不阻断启动（调用方仅打日志）。
pub(crate) async fn uninstall_deprecated_plugins(app_handle: &AppHandle) -> Result<(), String> {
    let presets = load_presets(app_handle);
    let names = deprecated_installed_names(&presets, |name| is_installed(app_handle, name));
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
        Err(failures.join("; "))
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
fn diagnostic_suffix(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

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
async fn ensure_pnpm(
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
            super::cancel::terminate_pid_tree(pid);
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
            super::process::mark_process_cleanup_failed(owner, reason.clone());
            super::cancel::terminate_owned_install(owner).await;
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
                    super::process::clear_process_cleanup_failed(owner);
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
        super::process::release_process_cleanup(owner, _pid_guard, _process_guard);
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
    super::cancel::terminate_pid_tree(pid);
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
                if super::process::plugin_process_has_exited(pid) {
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
    super::process::mark_process_cleanup_failed(pending.owner, pending.reason.clone());
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
    super::process::mark_process_cleanup_failed(owner, reason);
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
                super::process::release_process_cleanup(owner, pid_guard, process_guard);
            }
            Err(error) => {
                log::error!("pnpm version probe cleanup wait task failed: {error}");
                wait_for_probe_cleanup_with(
                    || !super::process::plugin_process_has_exited(pid),
                    PNPM_PROBE_LIVENESS_INTERVAL,
                )
                .await;
                super::process::release_process_cleanup(owner, pid_guard, process_guard);
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
    super::process::mark_process_cleanup_failed(owner, reason);
    super::cancel::terminate_pid_tree(pid);
    tauri::async_runtime::spawn(async move {
        wait_for_probe_cleanup_with(
            || !super::process::plugin_process_has_exited(pid),
            PNPM_PROBE_LIVENESS_INTERVAL,
        )
        .await;
        super::process::release_process_cleanup(owner, pid_guard, process_guard);
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
                !super::process::plugin_process_has_exited(pending.pid)
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
/// 供 [`ensure_pnpm`] 选版与 [`super::verify`] 的修复选版共用（store 主版本匹配）。
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
/// 供 [`ensure_pnpm`] 选版与 [`super::verify`] 的修复选版共用。
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
/// 供 [`ensure_pnpm`] 选版与 [`super::verify`] 的修复选版共用（store 主版本匹配）。
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

/// 从 pnpm 失败输出中解析需写入构建放行白名单的包名/键集合。
///
/// 兼容 pnpm 10 与 11 的两套输出形式（两者对 git 托管插件 prepare 门禁的提示不同）：
/// - pnpm 11（捆绑版）提示 `allowBuilds:\n  <key>: true`（map 形式），原样采纳 `<key>`；
/// - pnpm 10（旧 store 复用用户版）提示 `onlyBuiltDependencies:\n  - "<name>"`
///   （list 形式）与报错文本里的包名，二者归并取包名；
/// - 传递原生依赖被忽略构建（`Ignored build scripts:`）时，取其 `name@version` 的包名。
fn parse_allowlist_keys(output: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let lines: Vec<&str> = output.lines().collect();

    // 1) git 托管插件的允许键：跟随 `allowBuilds:` 示例行后的缩进 `<key>: true`。
    //    pnpm 11 的报错（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）建议按此形式放行。
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "allowBuilds:" {
            if let Some(next) = lines.get(idx + 1) {
                if let Some(key) = extract_allow_line_key(next) {
                    push_unique(&mut keys, key);
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
                // 版本号在最后一个 `@` 之后：scoped 包名（`@scope/name`）本身含 `@`，
                // 必须从尾部切分才能保留完整包名，否则 `split('@').next()` 会得到空串。
                let name = token
                    .rsplit_once('@')
                    .map_or(token, |(name, _)| name)
                    .trim();
                if !name.is_empty() {
                    push_unique(&mut keys, name.to_string());
                }
            }
        }
    }

    // 3) pnpm 10 的 `onlyBuiltDependencies:` 列表（git 托管插件 prepare 门禁）：
    //    onlyBuiltDependencies:
    //      - "dsh-better-sidebar"
    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == "onlyBuiltDependencies:" {
            for next in lines.iter().skip(idx + 1) {
                let trimmed = next.trim_start();
                if let Some(rest) = trimmed.strip_prefix('-') {
                    // 列表项：可能带缩进也可能不带（pnpm 提示段两种形式都出现过），
                    // 先于「顶层键」判定接受，避免无缩进条目被误当作顶层键提前退出。
                    let item = rest.trim().trim_matches(['"', '\'']);
                    if !item.is_empty() {
                        push_unique(&mut keys, item.to_string());
                    }
                } else if !next.starts_with(' ')
                    && !next.starts_with('\t')
                    && !trimmed.is_empty()
                    && !trimmed.starts_with('#')
                {
                    break; // 顶层键（无缩进且非列表项），已离开列表
                }
                // 其余（缩进行的非列表项、空行、注释）：继续扫描
            }
        }
    }

    // 4) pnpm 10 报错文本里的包名（`The git-hosted package "NAME@VER" ... "onlyBuiltDependencies" allowlist.`），
    //    与第 3 步归并：即便列表被截断也能从消息取回名字。
    for line in &lines {
        if let Some(name) = extract_only_builds_git_name(line) {
            push_unique(&mut keys, name);
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

/// 去重追加：避免同一键在不同输出块被重复计为待放行项。
fn push_unique(keys: &mut Vec<String>, key: String) {
    if !keys.iter().any(|k| k == &key) {
        keys.push(key);
    }
}

/// 从 pnpm 10 的 git 托管插件 prepare 门禁报错文本提取包名。
///
/// 形如 `The git-hosted package "NAME@VERSION" needs to execute build scripts
/// but is not in the "onlyBuiltDependencies" allowlist.`。
/// 仅匹配 `onlyBuiltDependencies` 形式的文本（pnpm 10）；pnpm 11 的 `allowBuilds`
/// 形式仍由 [`extract_allow_line_key`] 解析 `allowBuilds:` 块，二者互不干扰。
fn extract_only_builds_git_name(line: &str) -> Option<String> {
    if !line.contains("\"onlyBuiltDependencies\" allowlist") {
        return None;
    }
    let marker = "The git-hosted package \"";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    let quoted = &rest[..end]; // "name@version"
                               // 包名（含 scoped 前缀 `@scope/name`）在最末一个 `@` 之前，版本号在之后。
    let (name, _version) = quoted.rsplit_once('@')?;
    (!name.is_empty()).then(|| name.to_string())
}

/// 从 pnpm 11 的 git depPath 允许键（`name@<pkgResolutionId>`）提取纯包名；
/// 普通包名 / `name@version` 选择器原样返回。
///
/// pnpm 10 的 `onlyBuiltDependencies` 只按包名（或包名@版本）匹配，git depPath 里的
/// resolution id（`git+ssh://…` / `https://…` 等）对它没有意义，必须剥掉，否则该
/// 放行项在 pnpm 10 下不生效、git 插件的 prepare 构建仍会被构建门禁拦截。
fn dep_path_to_name(key: &str) -> String {
    const GIT_RES_ID_MARKERS: &[&str] =
        &["@git+", "@https://", "@http://", "@git://", "@github.com/"];
    for marker in GIT_RES_ID_MARKERS {
        if let Some(pos) = key.find(marker) {
            return key[..pos].to_string();
        }
    }
    key.to_string()
}

/// profile 下的 `pnpm-workspace.yaml` 路径（$DSH_HOME/profiles/<当前档案>）。
///
/// 构建放行项必须写进**当前活动档案**的工作区配置：`dsh plugin --profile <档案>`
/// 驱动的 pnpm 只读取该档案目录下的 `pnpm-workspace.yaml`，写错路径（如全局或其它
/// 档案）会让放行项失效，安装/升级仍会被 pnpm 的构建门禁拦截。
fn profile_workspace_path(app_handle: &AppHandle) -> PathBuf {
    profile_dir(app_handle).join("pnpm-workspace.yaml")
}

/// 把新的构建放行键合并写回 profile 的 `pnpm-workspace.yaml`，同时写入
/// `allowBuilds`（map，pnpm 11）与 `onlyBuiltDependencies`（list，pnpm 10）。
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
        std::fs::read_to_string(&path).map_err(|e| format!("PREINSTALL_READ_WORKSPACE: {e}"))?
    } else {
        // 与 dsh `initProfile` 生成的基础模板保持一致（尚无 allowBuilds）。
        "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n".to_string()
    };

    let rendered = apply_allow_build_keys(&content, keys)?;
    if rendered == content {
        return Ok(()); // 无变化（所有键已就位），避免无意义写盘
    }

    log::info!(
        "pnpm-workspace.yaml rewritten with allowBuilds {keys:?} at {}",
        path.display()
    );
    std::fs::write(&path, rendered).map_err(|e| format!("PREINSTALL_WRITE_WORKSPACE: {e}"))
}

/// 把新的构建放行键合并进 `pnpm-workspace.yaml` 文本并返回新文本。
///
/// 用 YAML 库（serde_yaml）整体改写而非字符串拼接，避免格式错乱：
/// - `allowBuilds`（pnpm 11）写为 map：键（git depPath 含 `@`/`/`/`:`/`#`）由库
///   自动按需加引号，已存在的同名键会被就地覆盖为 `true`，不残留占位值、不产生重复键；
/// - `onlyBuiltDependencies`（pnpm 10）写为 list：追加唯一的包名，不清空已有条目。
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
                return Err(format!("PREINSTALL_WORKSPACE_INVALID_YAML: {first_err}"));
            }
            repaired = true;
            serde_yaml::from_str(&normalized)
                .map_err(|e| format!("PREINSTALL_WORKSPACE_INVALID_YAML: {e}"))?
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

    // `allowBuilds` 的借用已在上面循环结束后释放（NLL），此处才能对 `map`
    // 再次取可变引用处理 `onlyBuiltDependencies`。
    //
    // pnpm 10（旧 store 复用的用户版）只认 `onlyBuiltDependencies`（list 形式，
    // 见其报错提示），因此这里一并写回，保证 pnpm 10 / 11 两版都能读到放行项；
    // `allowBuilds`（map 形式）覆盖 pnpm 11（捆绑版），二者共存互不冲突。
    //
    // 注意：pnpm 11 的 git 允许键是 `name@<pkgResolutionId>` 完整 depPath（按
    // resolution id 匹配，只能写进 allowBuilds）；pnpm 10 只按包名匹配，因此写入
    // onlyBuiltDependencies 前必须经 [`dep_path_to_name`] 剥成纯包名。
    let only_key = Value::String("onlyBuiltDependencies".to_string());
    let to_add: Vec<Value> = {
        let existing_only = map.get(&only_key).and_then(Value::as_sequence);
        keys.iter()
            .map(|k| dep_path_to_name(k))
            .filter(|name| {
                existing_only.is_none_or(|seq| !seq.contains(&Value::String(name.clone())))
            })
            .map(Value::String)
            .collect()
    };
    if !to_add.is_empty() {
        if !map.contains_key(&only_key) {
            map.insert(only_key.clone(), Value::Sequence(Vec::new()));
        }
        let only_builds = map
            .get_mut(&only_key)
            .and_then(Value::as_sequence_mut)
            .ok_or_else(|| {
                "PREINSTALL_WORKSPACE_ONLYBUILT_NOT_SEQ: onlyBuiltDependencies must be a sequence"
                    .to_string()
            })?;
        for v in to_add {
            only_builds.push(v);
            dirty = true;
        }
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

/// 给含空白字符的依赖 spec 加内嵌双引号，使其在 shell 拼接后仍保持单一 token。
///
/// **仅 Windows 需要引号。** `dsh plugin add` 在 JS 里用
/// `spawnSync("pnpm", args, { shell: process.platform === "win32" })` 启动 pnpm：
/// - Windows：`shell:true` 时 Node 只把参数按空格拼接、不做引号转义（官方文档
///   DEP0190：arguments are not escaped, only concatenated）。内置插件的依赖是
///   `link:<应用安装目录>`，而 Windows 安装目录常含空格（如
///   `G:\Deepseek Harness Desktop\resources\internal-plugins\dsh-tauri`），拼进
///   shell 后会被切碎成多个 spec，pnpm 报 `ERR_PNPM_SPEC_NOT_SUPPORTED` / 装成
///   错误依赖，导致启动自愈每轮都重装（死循环）。包一层双引号让 cmd 把整条
///   spec 视为一个参数；pnpm 解析后自行剥离引号，落盘 `package.json` 的值仍是
///   不带引号的规范 `link:<路径>`（与 [`super::preset::bundled_dep_spec`] 的
///   内核对账一致）。
/// - macOS / Linux：`shell:false`，pnpm 以 argv 数组直接启动、空格天然保留，
///   **加引号反而把字面 `"` 当成包名的一部分传给 pnpm → 非法 spec → exit 1**。
///   这是 issue #104 的根因：内置插件指向 `/Applications/Deepseek Harness
///   Desktop.app/...`（含空格），每次启动自愈重装都失败、服务永远缺该插件。
///
/// 因此只在 `cfg!(windows)` 且 spec 含空白时才包引号——普通 npm 包名 /
/// `git+https://...` 无空格，原样透传，避免无谓改动。
fn shell_quote_spec(spec: &str) -> String {
    #[cfg(windows)]
    {
        if spec.chars().any(|c| c == ' ' || c == '\t') {
            return format!("\"{spec}\"");
        }
    }
    spec.to_string()
}

/// 从 pnpm 失败输出里识别网络错误，返回稳定提示，避免把网络问题误报为 dsh
/// 子进程错误。代理、DNS、连接超时和 TLS 失败都属于此类。
fn network_error_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[&str] = &[
        "eai_again",
        "enotfound",
        "econnrefused",
        "econnreset",
        "etimedout",
        "network timeout",
        "network request failed",
        "fetch failed",
        "unable to verify the first certificate",
        "self signed certificate",
        "socket hang up",
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "connection reset",
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .any(|signal| lower.contains(signal))
        .then_some("网络连接失败，请检查网络或代理设置后重试。")
}

fn git_transport_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[(&str, &str)] = &[
        (
            "host key verification failed",
            "git fell back to SSH and could not verify GitHub's host key (no known_hosts entry; the process ran non-interactively). Make sure GitHub is reachable over HTTPS.",
        ),
        (
            "permission denied (publickey)",
            "git reached GitHub over SSH instead of HTTPS (Permission denied (publickey)) — usually your git config rewrites GitHub HTTPS to SSH (url.<base>.insteadOf) while no SSH key is configured. The desktop app isolates git config to force HTTPS for plugin installs; if you still see this, remove that rewrite (git config --global --unset-all 'url.git@github.com:.insteadOf') or configure an SSH key.",
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
    #[cfg(unix)]
    use super::pnpm_major_version_at;
    #[cfg(windows)]
    use super::pnpm_major_version_at_with_node;
    use super::{
        append_command_output, apply_allow_build_keys, collapse_allow_builds_duplicates,
        dep_path_to_name, deprecated_installed_names, diagnostic_suffix, extract_allow_line_key,
        extract_only_builds_git_name, git_transport_hint, has_github_ssh_rewrite_in_output,
        normalize_git_spec, parse_allowlist_keys, parse_store_major_from_modules_yaml,
        preset_spec_for_install, probe_output_or_fallback, probe_task_or_fallback, read_probe_pipe,
        rewrite_rule_targets_ssh_github, shell_quote_spec, silent_install_failure_detail,
        wait_for_probe_cleanup_with, PreinstallPluginInfo,
    };
    use std::path::PathBuf;

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
            deprecated: false,
        }
    }

    #[test]
    fn deprecated_installed_only_picks_marked_and_installed() {
        // 只把 `dsh-ok` 视为已安装，其余一律未安装（便于区分「标记但未安装」）。
        let installed = |name: &str| matches!(name, "dsh-ok" | "@scope/deprecated");

        // 命中：deprecated 且已安装 → 返回实际安装包名（dsh-ok 未声明 package，回落 id）
        let mut deprecated = preset("dsh-ok", "dshmarket", false);
        deprecated.deprecated = true;
        assert_eq!(
            deprecated_installed_names(&[deprecated], installed),
            vec!["dsh-ok".to_string()]
        );

        // scoped 包：返回真实安装包名（与预设 id 不一致）
        let mut scoped = preset("dsh-scoped", "github:x/y", false);
        scoped.deprecated = true;
        scoped.package = Some("@scope/deprecated".into());
        assert_eq!(
            deprecated_installed_names(&[scoped], installed),
            vec!["@scope/deprecated".to_string()]
        );

        // 未标记 deprecated：即使已安装也不命中
        let plain = preset("dsh-plain", "dsh-plain", false);
        assert!(deprecated_installed_names(&[plain], installed).is_empty());

        // 标记了但未安装：不命中
        let mut absent = preset("dsh-not-installed", "dshmarket", false);
        absent.deprecated = true;
        assert!(deprecated_installed_names(&[absent], installed).is_empty());

        // 内部插件即使标记 deprecated 也不命中（内部插件由启动自愈强制安装）
        let mut internal = preset("dsh-internal", "dsh-tauri@0.2.0", true);
        internal.deprecated = true;
        assert!(
            deprecated_installed_names(&[internal], |name| matches!(name, "dsh-internal")).is_empty()
        );
    }

    #[test]
    fn diagnostic_suffix_preserves_non_allowbuilds_failure() {
        assert_eq!(diagnostic_suffix(""), "");
        assert_eq!(
            diagnostic_suffix("ERR_PNPM_LINKING_FAILED: stale symlink"),
            ": ERR_PNPM_LINKING_FAILED: stale symlink"
        );
    }

    #[test]
    fn install_spec_passthrough_for_regular_preset() {
        // 普通插件：spec 原样返回，与捆绑目录无关
        let p = preset("dshmarket", "dshmarket", false);
        assert_eq!(preset_spec_for_install(&p, None).unwrap(), "dshmarket");
        assert_eq!(
            preset_spec_for_install(&p, Some(PathBuf::from("/ignored"))).unwrap(),
            "dshmarket"
        );
    }

    #[test]
    fn install_spec_uses_bundled_dir_for_internal_preset() {
        // 内置插件：安装依赖为 link:<捆绑目录>（正斜杠规范形；pnpm 对
        // `file:D:/...` 的盘符绝对路径会按相对解析，必须用 `link:`）
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let dir = PathBuf::from("C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri");
        assert_eq!(
            preset_spec_for_install(&p, Some(dir)).unwrap(),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
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

    /// 验证命令无输出且产物缺失时，会同时报告预期清单路径和可操作提示。
    #[test]
    fn silent_install_failure_reports_empty_output_and_expected_artifact() {
        let missing = vec![(
            "dsh-win-terminal-inspector".to_string(),
            PathBuf::from(
                "C:\\Users\\test\\.dsh\\profiles\\web\\node_modules\\dsh-win-terminal-inspector\\package.json",
            ),
        )];

        let detail = silent_install_failure_detail(&missing, "  \r\n");

        assert!(detail.starts_with("PREINSTALL_SILENT_FAIL:"));
        assert!(detail.contains("dsh-win-terminal-inspector"));
        assert!(detail.contains("package.json"));
        assert!(detail.contains("produced no output"));
        assert!(detail.contains("Retry the installation"));
    }

    /// 验证已有命令日志时，引导用户查看日志而不会误报为完全无输出。
    #[test]
    fn silent_install_failure_points_to_existing_command_log() {
        let missing = vec![(
            "dshmarket".to_string(),
            PathBuf::from("/tmp/profile/node_modules/dshmarket/package.json"),
        )];

        let detail = silent_install_failure_detail(&missing, "pnpm completed\n");

        assert!(detail.contains("Review the preinstall log above"));
        assert!(!detail.contains("produced no output"));
    }

    /// 验证最终重试无输出时，早期尝试产生的诊断不会被覆盖丢失。
    #[test]
    fn command_output_retains_earlier_retry_diagnostics() {
        let mut output = String::new();
        append_command_output(&mut output, "ERR_PNPM_IGNORED_BUILDS");
        append_command_output(&mut output, "");

        assert_eq!(output, "ERR_PNPM_IGNORED_BUILDS");
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
        assert!(keys.contains(
            &"dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string()
        ));
        assert!(!keys.contains(&"dsh-better-sidebar".to_string()));
    }

    #[test]
    fn parse_ignored_builds_name() {
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["node-pty".to_string()]);
    }

    #[test]
    fn parse_ignored_builds_scoped_name() {
        // 回归（CodeRabbit）：scoped 原生依赖 `@scope/name@version` 必须保留完整包名，
        // 不能按第一个 `@` 切分（那会得到空串导致该包被跳过、无法放行）。
        let out = "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @deepseek-ai/dsh-base@0.0.4, node-pty@1.1.0\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(
            keys,
            vec!["@deepseek-ai/dsh-base".to_string(), "node-pty".to_string()]
        );
    }

    #[test]
    fn parse_empty_when_irrelevant() {
        let out = "everything looks fine output\nno allowlist here\n";
        assert!(parse_allowlist_keys(out).is_empty());
    }

    #[test]
    fn parse_pnpm10_only_built_dependencies_list() {
        // 回归（issue：预装插件在 pnpm 10 下报 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED）：
        // pnpm 10（旧 store 复用的用户版）只输出 onlyBuiltDependencies 列表与报错文本
        // 里的包名，不含 allowBuilds 块。此前 parse_allowlist_keys 只认 allowBuilds，
        // 导致读不到 dsh-better-sidebar、不写白名单、重试也被跳过，安装必然失败。
        let out = "\
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from \"https://codeload.github.com/omdsh-dev/DSH-better-sidebar/tar.gz/f9153dfc1ce47cf43445c1b351ee3ae47b4ad9f1\"
The git-hosted package \"dsh-better-sidebar@0.16.1\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist.
...
This error happened while installing a direct dependency of C:\\Users\\hairy\\.dsh.dev\\profiles\\web
Add the package to \"onlyBuiltDependencies\" in your project's pnpm-workspace.yaml to allow it to run scripts. For example:
onlyBuiltDependencies:
- \"dsh-better-sidebar\"
";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["dsh-better-sidebar".to_string()]);
    }

    #[test]
    fn parse_pnpm10_unindented_list_items() {
        // 回归（CodeRabbit）：pnpm 10 提示段可能不带缩进（`- "name"` 与顶层键同列）。
        // 此前循环会把它误当顶层键提前退出，只靠报错文本回退解析才碰巧通过。
        let out = "onlyBuiltDependencies:\n- \"dsh-better-sidebar\"\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["dsh-better-sidebar".to_string()]);
    }

    #[test]
    fn parse_pnpm10_scoped_package_from_message() {
        // 报错文本在列表被截断时也可取回名字；scoped 包名保留 `@scope/` 前缀。
        let out = "The git-hosted package \"@deepseek-ai/dsh-base@0.0.4\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist.\n";
        let keys = parse_allowlist_keys(out);
        assert_eq!(keys, vec!["@deepseek-ai/dsh-base".to_string()]);
    }

    #[test]
    fn extract_only_builds_git_name_strips_version_and_handles_scoped() {
        // 普通包名：name@version → name
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"node-pty@1.1.0\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist."
            ),
            Some("node-pty".to_string())
        );
        // scoped 包名：@scope/name@version → @scope/name（只剥最末一个 @ 后的版本号）
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"@deepseek-ai/dsh-base@0.0.4\" needs to execute build scripts but is not in the \"onlyBuiltDependencies\" allowlist."
            ),
            Some("@deepseek-ai/dsh-base".to_string())
        );
        // pnpm 11 的 allowBuilds 文本不匹配（交由 allowBuilds 块解析）
        assert_eq!(
            extract_only_builds_git_name(
                "The git-hosted package \"dsh-better-sidebar@0.14.0\" needs to execute build scripts but is not in the \"allowBuilds\" allowlist."
            ),
            None
        );
        // 非 git 门禁行不匹配
        assert_eq!(
            extract_only_builds_git_name("allowBuilds:\n  x: true"),
            None
        );
    }

    #[test]
    fn dep_path_to_name_strips_git_resolution_keeps_plain_names() {
        // git depPath（unscoped）：剥掉 resolution id，保留纯包名
        assert_eq!(
            dep_path_to_name(
                "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
            ),
            "dsh-better-sidebar"
        );
        // git depPath（scoped）：同样只剥 resolution id，保留 `@scope/name`
        assert_eq!(
            dep_path_to_name(
                "@deepseek-ai/dsh-base@git+https://github.com/deepseek-ai/dsh-base.git#abc123"
            ),
            "@deepseek-ai/dsh-base"
        );
        // 普通包名 / 包名@版本选择器：原样返回
        assert_eq!(dep_path_to_name("node-pty"), "node-pty");
        assert_eq!(dep_path_to_name("node-pty@1.1.0"), "node-pty@1.1.0");
        assert_eq!(dep_path_to_name("@scope/pkg"), "@scope/pkg");
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
        // 已放行的键再次写入：结果不变（幂等、不产生重复键）。输入须同时包含
        // allowBuilds 与 onlyBuiltDependencies 两个放行出口（桌面端双写，见
        // apply_allow_build_keys），证明两处都幂等。
        let base = "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\nonlyBuiltDependencies:\n  - node-pty\n";
        let out = apply_allow_build_keys(base, &["node-pty".to_string()]).unwrap();
        assert_eq!(out, base);
    }

    #[test]
    fn apply_writes_both_allowbuilds_and_only_built_dependencies() {
        // pnpm 11 认 allowBuilds（map），pnpm 10 认 onlyBuiltDependencies（list），
        // 两者须同时写回，用户 pnpm 10 / 捆绑版 pnpm 11 都能读到放行项。
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        let out = apply_allow_build_keys(base, &["dsh-better-sidebar".to_string()]).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // pnpm 11：allowBuilds 为 map 形式
        assert_eq!(
            doc["allowBuilds"]["dsh-better-sidebar"],
            serde_yaml::Value::Bool(true)
        );
        // pnpm 10：onlyBuiltDependencies 为 list 形式
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        assert_eq!(
            only,
            &vec![serde_yaml::Value::String("dsh-better-sidebar".to_string())]
        );
        // 基础设置被保留
        assert!(doc.get("packages").is_some());
        assert!(doc.get("nodeLinker").is_some());
    }

    #[test]
    fn apply_git_dep_path_writes_name_selector_for_pnpm10() {
        // 回归（CodeRabbit）：git 托管插件的完整 depPath 只写进 pnpm 11 的 allowBuilds
        // （按 resolution id 匹配）；pnpm 10 的 onlyBuiltDependencies 只按包名匹配，
        // 必须剥成纯包名，否则 pnpm 10 读不到放行项、prepare 构建仍会被门禁拦截。
        // 两个出口同时写好后，pnpm 10 / 11 之间切换都不会再次触发构建门禁。
        let base = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
        let dep =
            "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string();
        let out = apply_allow_build_keys(base, &[dep.clone()]).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        // pnpm 11：allowBuilds 保留完整 depPath
        assert_eq!(
            doc["allowBuilds"][&serde_yaml::Value::String(dep)],
            serde_yaml::Value::Bool(true)
        );
        // pnpm 10：onlyBuiltDependencies 只含纯包名
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        assert_eq!(
            only,
            &vec![serde_yaml::Value::String("dsh-better-sidebar".to_string())]
        );
    }

    #[test]
    fn apply_only_built_dependencies_preserves_existing_entries() {
        // onlyBuiltDependencies 已含旧条目时，只追加新键、不清空原有条目。
        let base = "packages:\n  - .\nallowBuilds:\n  esbuild: true\nonlyBuiltDependencies:\n  - esbuild\n";
        let out = apply_allow_build_keys(base, &["dsh-better-sidebar".to_string()]).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let only = doc
            .get("onlyBuiltDependencies")
            .and_then(serde_yaml::Value::as_sequence)
            .expect("onlyBuiltDependencies must be a sequence");
        let names: Vec<&str> = only.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(names, vec!["esbuild", "dsh-better-sidebar"]);
    }

    #[test]
    fn apply_quotes_git_dep_path_keys() {
        let dep =
            "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                .to_string();
        // 空内容也能生成合法配置
        let out = apply_allow_build_keys("", &[dep.clone()]).unwrap();
        let map = allow_builds_map(&out);
        assert_eq!(
            map.get(serde_yaml::Value::String(dep)),
            Some(&serde_yaml::Value::Bool(true))
        );
        // 库负责正确加引号，键原样（含 @ / : / #）可回读
        let doc: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            doc["allowBuilds"][&serde_yaml::Value::String(
                "dsh-better-sidebar@git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git#6c89"
                    .to_string()
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
            .filter(|l| {
                l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'")
            })
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
            .filter(|l| {
                l.trim_start().starts_with("node-pty") || l.trim_start().starts_with("'node-pty'")
            })
            .count();
        assert_eq!(node_pty, 1);
        assert!(normalized.contains("keep"));
        // 去重结果必须是合法 YAML，且能被后续解析
        let out = apply_allow_build_keys(&normalized, &["node-pty".to_string()]).unwrap();
        assert_eq!(
            allow_builds_map(&out).get("node-pty"),
            Some(&serde_yaml::Value::Bool(true))
        );
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

    // ---- spec 引号化（仅 Windows：dsh CLI 只在 win32 用 shell 拼接参数）----

    #[cfg(windows)]
    #[test]
    fn shell_quote_quotes_spec_containing_spaces() {
        // 安装目录含空格（如 G:\Deepseek Harness Desktop）：整条 spec 加双引号，
        // 使 dsh CLI 的 shell:true 拼接后仍被 shell 视为单一 token（DEP0190：
        // Node 对 shell:true 只拼接不转义）
        assert_eq!(
            shell_quote_spec(
                "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri"
            ),
            "\"link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri\""
        );
        // 制表符同样触发
        assert_eq!(shell_quote_spec("link:C:/x\ty"), "\"link:C:/x\ty\"");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_quote_leaves_space_path_untouched_on_non_windows() {
        // 回归（issue #104）：macOS/Linux 上 dsh CLI 直接 spawnSync（shell:false），
        // spec 作为一个 argv 传递、空格天然保留，绝不能加引号——字面 `"` 会成为
        // 包名的一部分，pnpm 报非法 spec → exit 1 → 内置插件每次启动重装都失败。
        assert_eq!(
            shell_quote_spec("link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"),
            "link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"
        );
        assert_eq!(
            shell_quote_spec("link:/Users/me/my plugins/dsh-tauri"),
            "link:/Users/me/my plugins/dsh-tauri"
        );
    }

    #[test]
    fn shell_quote_leaves_space_free_spec_untouched() {
        // 普通 npm 包名 / git HTTPS spec 无空格：原样透传，不引入多余引号
        assert_eq!(shell_quote_spec("dshmarket"), "dshmarket");
        assert_eq!(
            shell_quote_spec("git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 无空格的内置插件路径同样不被改动（保持与 internal.rs expected 一致）
        assert_eq!(
            shell_quote_spec("link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shell_quote_preserves_link_prefix_semantics() {
        // 引号只包 path 部分也不影响 pnpm 解析（落盘值仍为不带引号的 link: 规范形）
        let quoted = shell_quote_spec(
            "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri",
        );
        assert!(quoted.starts_with('"'));
        assert!(quoted.ends_with('"'));
        assert!(quoted.contains("Deepseek Harness Desktop"));
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
        assert!(
            git_transport_hint("ssh: connect to host github.com port 22: Connection refused")
                .is_some()
        );
    }

    #[test]
    fn git_transport_hint_none_for_allowbuilds_output() {
        // allowBuilds 场景（prepare 构建被拦）不应误判为传输层错误
        let out = "[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ...\nallowBuilds:\n  node-pty: true\n";
        assert!(git_transport_hint(out).is_none());
    }

    #[test]
    fn rewrite_rule_targets_ssh_github_detects_common_rewrites() {
        // GitHub 官方文档的经典写法：HTTPS -> SSH（scp 风格与 ssh:// 风格）
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@github.com:.insteadof https://github.com/"
        ));
        assert!(rewrite_rule_targets_ssh_github(
            "url.ssh://git@github.com/.insteadof https://github.com/"
        ));
        assert!(rewrite_rule_targets_ssh_github(
            "url.git+ssh://git@github.com/.insteadof https://github.com"
        ));
        // http 同样属于被改写对象；value 无尾斜杠也能命中
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@github.com:.insteadof http://github.com"
        ));
        // subsection 大小写保留、key 小写化后仍可识别
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@Github.com:.insteadOf https://github.com/"
        ));
    }

    #[test]
    fn rewrite_rule_targets_ssh_github_ignores_harmless_rules() {
        // 反向规则（ssh -> https）、非 GitHub 主机、https base 都不隔离
        assert!(!rewrite_rule_targets_ssh_github(
            "url.https://github.com/.insteadof git@github.com:"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.git@gitlab.example.com:.insteadof https://gitlab.example.com/"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.ssh://git@github.com/.pushinsteadof https://github.com/"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.file:///c:/git/.insteadof https://github.com/"
        ));
        // 非 url 键与空行
        assert!(!rewrite_rule_targets_ssh_github("core.autocrlf true"));
        assert!(!rewrite_rule_targets_ssh_github(""));
        assert!(!rewrite_rule_targets_ssh_github("   "));
    }

    #[test]
    fn has_github_ssh_rewrite_in_output_checks_all_lines() {
        let harmful = "core.autocrlf true\nuser.name=x\nurl.git@github.com:.insteadof https://github.com/\n";
        assert!(has_github_ssh_rewrite_in_output(harmful));
        let clean = "core.autocrlf true\nuser.name=x\nurl.https://github.com/.insteadof git@github.com:\n";
        assert!(!has_github_ssh_rewrite_in_output(clean));
        assert!(!has_github_ssh_rewrite_in_output(""));
    }
}
