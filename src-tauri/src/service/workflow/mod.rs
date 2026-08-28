pub(crate) mod client_hmr_patch;
pub(crate) mod renderer_patch;
pub mod status;
pub mod utils;
pub(crate) mod win_inspector;
#[cfg(windows)]
pub(crate) mod win_spawn;
pub(crate) mod workspace_patch;

use crate::config;
use crate::service::download;
use crate::service::workflow::utils::{is_port_in_use, spawn_output_readers};
use std::collections::HashMap;

#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
static LAUNCH_GUARD: AtomicBool = AtomicBool::new(false);

/// 当前进程内由桌面端创建的 Harness 根进程（PID + Windows 句柄）。
///
/// PID 与句柄装在同一把锁的可选值里：`take()` 一次性成对取出，保证
/// 「PID 清空」与「句柄关闭」之间不存在跨原子竞态（WARN-6）。历史上 PID/句柄
/// 分两个 `Atomic*` 存储，`stop` 读 PID 与监视线程清句柄之间有微窗口可能导致
/// 漏杀或重复 close。
#[derive(Clone, Copy)]
struct OwnedProcess {
    pid: u32,
    /// Windows 进程句柄（原始 HANDLE 转 usize 存储，避免 `*mut c_void` 非 Send）。
    /// 只在 Windows 存在；Unix 无句柄概念。
    #[cfg(windows)]
    handle: usize,
}

fn owned_process_lock() -> &'static Mutex<Option<OwnedProcess>> {
    static OWNED_PROCESS: OnceLock<Mutex<Option<OwnedProcess>>> = OnceLock::new();
    OWNED_PROCESS.get_or_init(|| Mutex::new(None))
}

/// 记录新持有的 Harness 根进程（Unix，启动成功后调用）。
#[cfg(not(windows))]
fn set_owned_process(pid: u32) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid });
}

/// 若调用方 owns 该进程（Windows 额外存句柄），记录之。
#[cfg(windows)]
fn set_owned_process_with_handle(pid: u32, handle: usize) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid, handle });
}

/// 原子取出持有的进程（PID+句柄一起）。Whoever takes it is responsible for
/// closing the Windows handle. 无条件取出（停止/退出路径）。
fn take_owned_process() -> Option<OwnedProcess> {
    owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// 仅当当前持有进程的 PID 与 `pid` 匹配时才取出（成对 PID+句柄）。
///
/// 保留 base 代码 `compare_exchange(pid, 0)` 的防护语义：退出监视线程只能清掉
/// 属于自己那一条登记，绝不误取/误清「刚启动的新进程」的登记——否则会把它
/// 当作已退出而错误回落 Status，并把新进程的句柄误关（WARN-6 合并引入的回退）。
fn take_owned_process_if(pid: u32) -> Option<OwnedProcess> {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    take_owned_process_if_matching(&mut guard, pid)
}

/// 纯函数部分：便于单测，不触碰全局状态。
fn take_owned_process_if_matching(
    owned: &mut Option<OwnedProcess>,
    pid: u32,
) -> Option<OwnedProcess> {
    if owned.as_ref().map(|p| p.pid) == Some(pid) {
        owned.take()
    } else {
        None
    }
}

struct LaunchGuard;

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCH_GUARD.store(false, Ordering::SeqCst);
    }
}

/// 端口释放等待上限：刚结束/清扫过上个会话的残留 dsh 进程后，TCP 端口释放
/// 存在短暂滞后（taskkill 返回 ≠ 端口已可复用）。等待窗口内端口回落为空闲则
/// 复用配置端口；到期仍未释放才按“真占用”逐级递增。
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 轮询等待配置端口释放为空闲（端口本来就空闲则立即返回）。
///
/// async（tokio）实现，避免长时间阻塞启动线程。与 `stop()` 里“给系统一点时间
/// 释放端口”的目的一致，但以“端口确实空闲”为准而不是固定睡 800ms——因此
/// 端口很快释放时几乎不额外耗时，只有真占用才等到超时。
async fn wait_for_port_release(port: u16) {
    let deadline = tokio::time::Instant::now() + PORT_RELEASE_WAIT;
    while tokio::time::Instant::now() < deadline {
        if !is_port_in_use(port) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
}

/// 从起始端口向上查找第一个空闲端口，绝不结束未知的端口占用进程。
fn find_available_port(start: u16) -> Result<u16, String> {
    find_available_port_by(start, is_port_in_use)
}

/// 按调用方提供的占用判定查找第一个空闲端口。
///
/// 将扫描决策与真实套接字状态分离，使单测能确定性验证递增与溢出，不在函数
/// 返回后再次探测系统端口；后者存在不可消除的 TOCTOU，任何端口段都可能被
/// 其他进程在两次探测之间占用。
fn find_available_port_by(
    start: u16,
    mut is_in_use: impl FnMut(u16) -> bool,
) -> Result<u16, String> {
    let mut port = start;
    loop {
        if !is_in_use(port) {
            return Ok(port);
        }
        log::warn!("Port {port} is occupied, trying the next port");
        port = port.checked_add(1).ok_or_else(|| {
            "PORT_EXHAUSTED: no available TCP port after the configured port".to_string()
        })?;
    }
}

/// 启动时端口自愈决策（纯函数，便于单测）。
///
/// 自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口只在回落目标
/// （用户手动端口或默认端口）空闲时才回落；回落目标被占则维持当前端口，
/// 留给 `find_available_port` 逐级递增。用户手动设置的端口经 `manual_port`
/// 记录，回落目标即用户值；从未手动设置时回落目标是默认端口（3080/3081）。
/// 返回值与 `configured` 相同表示无需自愈。
fn resolve_heal_port(configured: u16, heal_target: u16, heal_target_free: bool) -> u16 {
    if configured != heal_target && heal_target_free {
        heal_target
    } else {
        configured
    }
}

/// dsh 版本是否支持 `--no-open` 标志。
///
/// 0.1.0-rc.8 起 `dsh web` 默认在系统浏览器打开 UI（桌面端内嵌 WebView，
/// 不希望每次启动都弹浏览器），并新增 `--no-open` 关闭该行为。更早的 rc
/// 版本没有这个标志，commander 会把未知选项当作错误、导致 web profile
/// 启动失败，因此追加标志前必须按已装版本判定：0.1.0-rc.8 及以上传标志；
/// 更早不传（保持旧行为）。
///
/// 比较用 `semver` 库按完整语义化版本进行：只比 rc 序号会把基础版本更大的
/// 新版本误判为旧版——`0.1.1-rc.1` 的 rc 号（1）虽小于 8，但晚于
/// 0.1.0-rc.8，同样支持 `--no-open`（该误判是浏览器复弹的回归根因）。
/// 版本号非法（无法解析）时保守处理：不追加标志。
fn version_supports_no_open(version: &str) -> bool {
    // 首个支持 `--no-open` 的 dsh 版本（0.1.0-rc.8）
    const NO_OPEN_MIN_VERSION: &str = "0.1.0-rc.8";
    let Ok(min) = semver::Version::parse(NO_OPEN_MIN_VERSION) else {
        return false;
    };
    semver::Version::parse(version)
        .map(|v| v >= min)
        .unwrap_or(false)
}

/// 按当前活动核心的 dsh 版本决定是否追加 `--no-open`（见 [`version_supports_no_open`]）。
///
/// 版本以活动核心为准：本地核心（用户 CLI 安装）与预打包核心各自读自己的
/// 包清单；读不到时保守处理：不追加标志。
fn web_supports_no_open_flag(app_handle: &tauri::AppHandle) -> bool {
    match crate::service::core::active_version(app_handle) {
        Some(version) => version_supports_no_open(&version),
        None => false,
    }
}

/// 只结束本应用当前进程创建并仍持有的 Harness 进程树。
fn terminate_owned_process() {
    // 一次性取出 PID+句柄（成对），杜绝「PID 已清空/句柄未清」的漏杀窗口
    let Some(owned) = take_owned_process() else {
        return;
    };

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        const WAIT_TIMEOUT_CODE: u32 = 0x0000_0102;
        let handle = owned.handle as windows_sys::Win32::Foundation::HANDLE;
        if handle.is_null() {
            return;
        }
        // 真实句柄已结束说明 PID 可能已复用，此时绝不调用 taskkill。
        if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT_CODE {
            unsafe { CloseHandle(handle) };
            return;
        }
        kill_pid_tree(owned.pid);
        unsafe {
            WaitForSingleObject(handle, 5_000);
            CloseHandle(handle);
        }
    }

    #[cfg(unix)]
    {
        kill_pid_tree(owned.pid);
    }
}

/// 结束进程树（Windows `taskkill /PID <pid> /T /F`；Unix 负 PID 进程组，与
/// 启动时 `process_group(0)` 对应）。调用方需先确认 PID 确实指向目标进程。
fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        if let Err(e) = cmd.output() {
            log::error!("Failed to stop Harness process tree {pid}: {e}");
        }
    }

    #[cfg(unix)]
    {
        // Harness 根进程启动在独立进程组中，负 PID 只作用于该进程树；手动通过
        // CLI 拉起的外围 dsh 进程未必有独立进程组（组信号报错），此时回退直接
        // 杀 PID——PID 的归属已由调用方确认（路径匹配或 .harness.pid 双重确认），
        // 绝不会误杀未知进程。
        let group = format!("-{pid}");
        let group_term_ok = Command::new("kill")
            .args(["-TERM", "--", &group])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !group_term_ok {
            let _ = Command::new("kill")
                .args(["-TERM", "--", &pid.to_string()])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let group_kill_ok = Command::new("kill")
            .args(["-KILL", "--", &group])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !group_kill_ok {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &pid.to_string()])
                .output();
        }
    }
}

/// 解析 `ps -axo pid=,command=` 的一行：返回 `(PID, 命令行)`。
///
/// 输出形如 `   12345 node /path/to/bin.js --profile web ...`（PID 前可能有
/// 前导空格、行尾有换行）。PID 缺失或不可解析的行返回 None（跳过该行）。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn parse_ps_line(line: &str) -> Option<(u32, &str)> {
    let trimmed = line.trim_start();
    let split = trimmed.find(|c: char| c.is_whitespace())?;
    let pid = trimmed[..split].trim().parse::<u32>().ok()?;
    Some((pid, trimmed[split..].trim_start()))
}

/// 判断命令行中是否包含一个完整参数。
///
/// `ps` 会把 argv 用空格拼成命令行，但不会给本身含空格的参数补引号，因此不能
/// 用 `split_whitespace` 还原参数。改为在原始命令行中匹配完整字符串，并校验
/// 前后为空白或行边界；这样 macOS 的 `Library/Application Support` 路径也能
/// 正确识别，同时不会把路径前缀相似的其他参数误判为目标。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn command_line_has_argument(cmdline: &str, argument: &str) -> bool {
    if argument.is_empty() {
        return false;
    }

    cmdline.match_indices(argument).any(|(start, matched)| {
        let before_is_boundary = cmdline[..start]
            .chars()
            .next_back()
            .map_or(true, char::is_whitespace);
        let end = start + matched.len();
        let after_is_boundary = cmdline[end..]
            .chars()
            .next()
            .map_or(true, char::is_whitespace);
        before_is_boundary && after_is_boundary
    })
}

/// 判断命令行是否为「从本应用 dsh 安装目录启动的 Harness 服务」。
///
/// 除入口路径外同时核对桌面端服务启动参数，避免清扫时误伤用户并行执行的
/// `dsh plugin` 等短命令。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn is_harness_command_line(cmdline: &str, dsh_bin: &str) -> bool {
    command_line_has_argument(cmdline, dsh_bin)
        && command_line_has_argument(cmdline, "--host")
        && command_line_has_argument(cmdline, "127.0.0.1")
        && command_line_has_argument(cmdline, "--port")
}

pub fn has_owned_process() -> bool {
    owned_process_lock()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// 处理「持有的 dsh 进程退出」这一事实（由退出监视线程与健康检查 tick 共用）：
///
/// - 仅当退出的 PID 仍是当前登记的那个进程时才清空持有（`take_owned_process_if`
///   按 pid 匹配），PID/句柄作为整体成对取出——杜绝「读 PID」与「清句柄」
///   之间的跨原子竞态（WARN-6），也杜绝旧监视线程误清新启动进程的登记；
/// - 若当前状态仍是 Running，回落到 Stopped——否则进程已经没了、状态却永远
///   显示「运行中」，前端按钮/横幅会长期处于错误语义（WARN-5）。
///
/// 返回被取出的进程记录（含 Windows 句柄），取到者负责 `CloseHandle`——保证
/// 「取走进程」与「关闭句柄」同属一个调用者，杜绝重复 close。幂等：多次调用
/// （tick 与监视线程并发）只会生效一次，后续调用返回 None。
fn on_owned_process_exit(pid: u32) -> Option<OwnedProcess> {
    let owned = take_owned_process_if(pid)?;

    log::warn!(
        "Owned Harness process {} exited; resetting status to Stopped",
        owned.pid
    );

    if status::get_status() == status::Status::Running {
        status::set_status(status::Status::Stopped);
    }
    Some(owned)
}

/// 结束所有从本应用 dsh 安装目录启动的 Harness 服务进程（含历史崩溃残留的孤儿实例）。
///
/// 只停本应用当前持有的进程不够：`.harness.pid` 标记只记录最近一次会话的 PID，
/// 应用多次崩溃/强杀（任务管理器结束等）会遗留多个孤儿 dsh 进程、端口一路漂移
/// （3080→3081→…），`sweep_orphan_harness` 每次只能回收最近一个，更早的孤儿
/// 会持续占用 `dependencies/dsh` 目录的文件句柄（node 以该目录为 cwd 且模块
/// DLL 加载在内存），更新切换目录时触发 os error 32（INSTALL_BACKUP_FAILED）。
///
/// 命令行为本应用 dsh 入口路径（`...\dependencies\dsh\node_modules\...\bin.js`）
/// 的 node 进程可判定为本应用的服务实例——路径精确匹配不会误杀用户其它 node
/// 程序，因此可安全地全部结束（taskkill /T /F）。
pub fn terminate_stale_harness_processes(app_handle: &tauri::AppHandle) {
    // 开发（debug）构建不做按路径清扫：生产与开发共用同一个 `dependencies/dsh`
    // 安装目录（核心共用），按命令行路径匹配会把同时运行的 release 服务进程
    // 一并结束——`pnpm tauri dev` 每次后端重编译都会重启应用并触发清扫，导致
    // "release 版 DSH 被 dev 版热更新杀掉"。开发构建自身的崩溃残留仍由
    // `.harness.pid` 标记（位于独立数据目录 `.dsh.dev`，PID+端口双重确认）
    // 精确回收。
    if cfg!(debug_assertions) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let dsh_bin_path = config::get_dsh_binary_path(app_handle);
        let Some(dsh_bin) = dsh_bin_path.to_str() else {
            return;
        };
        // 进程名过滤保证 PowerShell 自身（其命令行同样包含该路径）不被误杀；
        // 路径中的单引号按 PS 字符串字面量规则转义，避免用户目录含 `'` 时语法错误。
        let escaped = dsh_bin.replace('\'', "''");
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {{ $_.CommandLine -like '*{escaped}*' }} | Select-Object -ExpandProperty ProcessId"
        );
        let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .output()
        else {
            log::error!("Failed to enumerate stale Harness service processes");
            return;
        };
        let mut found = 0;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Ok(pid) = line.trim().parse::<u32>() else {
                continue;
            };
            found += 1;
            log::warn!("Terminating stale Harness service process {pid} (from dsh install dir)");
            kill_pid_tree(pid);
        }
        if found > 0 {
            // 与 stop() 同理：taskkill 返回后 DLL 句柄的释放还有短暂滞后，
            // 让出一点时间避免紧随其后的目录切换撞上残留锁。
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
    }
    #[cfg(not(windows))]
    {
        // Unix 同样需要按路径清扫：打开中的文件允许重命名确实不阻塞更新切换，
        // 但崩溃/强杀残留的孤儿 dsh 实例会持续监听端口，下一次启动只能一路
        // 漂移端口（3080→3081→…）并被持久化，表现为「更新后端口递增」
        // （issue #91）。用 `ps -ww -axo pid=,command=` 枚举完整命令行（`-ww`
        // 防止 macOS 按终端宽度截断长路径），按参数边界匹配本应用 dsh 入口与
        // 服务参数，不会误杀用户其它 node/dsh 命令，因此可安全地全部结束。
        let dsh_bin = config::get_dsh_binary_path(app_handle);
        let Some(dsh_bin_str) = dsh_bin.to_str() else {
            return;
        };
        let Ok(output) = Command::new("ps")
            .args(["-ww", "-axo", "pid=,command="])
            .output()
        else {
            log::error!("Failed to enumerate stale Harness service processes");
            return;
        };
        let mut found = 0;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Some((pid, cmdline)) = parse_ps_line(line) else {
                continue;
            };
            if !is_harness_command_line(cmdline, dsh_bin_str) {
                continue;
            }
            found += 1;
            log::warn!("Terminating stale Harness service process {pid} (from dsh install dir)");
            kill_pid_tree(pid);
        }
        if found > 0 {
            // 与 stop() 同理：信号发完后 PID 回收与端口释放还有短暂滞后，
            // 让出一点时间避免紧随其后的启动探测撞上尚未释放的端口。
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
    }
}

#[cfg(unix)]
pub(crate) fn warn_if_inotify_watch_limit_low() {
    let Some(limit) = crate::config::linux_inotify_max_user_watches() else {
        return;
    };
    if limit < crate::config::MIN_INOTIFY_MAX_USER_WATCHES {
        log::warn!(
            "Linux inotify.max_user_watches is {} (below recommended {}); dsh web may crash with ENOSPC (issue #116). To fix, run `sudo sysctl fs.inotify.max_user_watches={}` and write the same value to /etc/sysctl.conf to persist.",
            limit,
            crate::config::MIN_INOTIFY_MAX_USER_WATCHES,
            crate::config::MIN_INOTIFY_MAX_USER_WATCHES,
        );
    }
}

// ---------------------------------------------------------------------------
// 孤儿 Harness 清扫：崩溃/强杀残留实例的识别与回收（issue #34 关联现象）
// ---------------------------------------------------------------------------

/// 孤儿清扫用的 PID/端口标记文件路径（$DSH_HOME/.harness.pid，两行：PID、端口）。
///
/// 应用被强杀（崩溃、任务管理器结束等）时无法执行退出清理，其 Harness 子进程
/// 会继续占用端口；下一次启动只能一路漂移端口（3080→3081→…）并触发服务端
/// "already running"，表现为应用"坏掉"。启动前据此文件识别并清理这类残留。
fn harness_pid_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    config::get_dsh_data_path(app_handle).join(".harness.pid")
}

/// 记录本次启动的 Harness PID 与端口，供下次启动清扫孤儿用。
fn persist_harness_pid(app_handle: &tauri::AppHandle, pid: u32, port: u16) {
    let path = harness_pid_path(app_handle);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, format!("{pid}\n{port}\n"));
}

/// 启动前清扫上次崩溃残留的孤儿 Harness。端口与 PID 双重确认后才动手：
/// - 标记进程已死 → 仅清理陈旧标记；
/// - 端口占用者正是标记中的 PID → 本应用残留，结束其进程树并清标记；
/// - 其余情况（标记不可解析、端口被其他程序占用、无法探测占用者）一律不动，
///   绝不凭端口猜进程、绝不杀未知进程。
pub fn sweep_orphan_harness(app_handle: &tauri::AppHandle) {
    if has_owned_process() {
        return;
    }
    // 先按命令行路径清扫所有从本应用 dsh 安装目录启动的孤儿 Harness 实例：
    // 标记文件只记录最近一次会话的 PID，应用多次崩溃/强杀会遗留更早的孤儿
    // （端口一路漂移 3081/3082/…），它们持续占用 dependencies/dsh 目录的文件
    // 句柄，导致更新切换目录失败（INSTALL_BACKUP_FAILED, os error 32）。
    // 路径精确匹配不会误杀用户其它 node 程序；标记中的进程若在其中会被一并
    // 结束，随后的 PID/端口双重确认自然落空，仅清理陈旧标记。
    terminate_stale_harness_processes(app_handle);
    let pid_file = harness_pid_path(app_handle);
    let Ok(text) = fs::read_to_string(&pid_file) else {
        return;
    };
    let mut lines = text.lines();
    let (Some(pid), Some(port)) = (
        lines.next().and_then(|l| l.trim().parse::<u32>().ok()),
        lines.next().and_then(|l| l.trim().parse::<u16>().ok()),
    ) else {
        // 标记内容不可解析：陈旧垃圾，清掉即可
        let _ = fs::remove_file(&pid_file);
        return;
    };
    if !is_port_in_use(port) {
        // 端口已释放：残留实例早已自行退出，仅清理标记
        let _ = fs::remove_file(&pid_file);
        return;
    }
    if port_owner_pid(port) != Some(pid) {
        // 端口占用者不是我们落盘的进程（或探测不到）：可能是其他程序，不动
        return;
    }
    log::warn!("Sweeping orphaned Harness process {pid} (port {port}) left by a previous session");
    kill_pid_tree(pid);
    let _ = fs::remove_file(&pid_file);
}

/// 占用指定端口的进程 PID（LISTENING 状态）。
/// - Windows：`netstat -ano` 解析；
/// - Unix：`lsof -ti tcp:<port>`，不可用时返回 None。
/// 返回 None 视为"无法确认"，调用方不会因此杀任何进程。
fn port_owner_pid(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        // 打包版是 GUI 进程（无控制台）：netstat 是控制台子系统程序，直接运行会
        // 新建一个可见的黑色 cmd 窗口（启动时的孤儿清扫会走到这里）。必须
        // CREATE_NO_WINDOW，否则每次启动闪一个黑窗。
        use std::os::windows::process::CommandExt;
        let output = Command::new("netstat")
            .arg("-ano")
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let needle = format!(":{port} ");
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 || fields[0] != "TCP" {
                continue;
            }
            // 本地地址列（如 127.0.0.1:3080 / [::1]:3080）以 :<port> 结尾
            if !fields[1].ends_with(&needle) {
                continue;
            }
            if fields[3] == "LISTENING" {
                return fields[4].parse().ok();
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        // lsof 在 macOS 默认可用、Linux 常缺失；缺失时跳过清扫（返回 None）
        let output = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .and_then(|l| l.trim().parse().ok())
    }
}

/// Windows RedirectionGuard（错误码 448 = ERROR_UNTRUSTED_MOUNT_POINT）逃逸重拉的标记路径。
fn relaunch_marker_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    config::get_base_dir(app_handle).join(".dsh-relaunch-448")
}

/// 探测 dsh 入口在当前进程上下文下的打开错误码（None=可打开）。
///
/// 448 只在「进程继承 RedirectionGuard 强制执行」时出现；干净上下文（父进程为
/// explorer 等普通进程）下 Level-1 符号链接可正常穿越。
fn dsh_bin_open_error(app_handle: &tauri::AppHandle) -> Option<i32> {
    std::fs::File::open(config::get_dsh_binary_path(app_handle))
        .err()
        .and_then(|e| e.raw_os_error())
}

/// 通过 explorer 转交启动请求，脱离 RedirectionGuard 强制执行上下文后退出本进程。
///
/// Windows 11 25H2 的 RedirectionGuard 对「非提权进程创建的符号链接/联接点」盖信任章，
/// 而安装器（msiexec/RestartManager 自动重开）会在自身进程启用强制执行并随进程树继承，
/// 导致新实例跨越 pnpm 符号链接链打开 bin.js 时持续报 448——实测与等待时长无关、
/// 永不自行恢复（issue #35）。应用无法在运行时关闭继承的策略，只能脱离被污染的进程树：
/// 把启动请求转交给 explorer（单实例壳进程，干净上下文），由 explorer 创建新实例，
/// 其父进程即 explorer，不再继承强制执行（实测：explorer.exe <exe> 的子进程父进程为
/// explorer.exe，而非转交发起者）。标记文件用于防死循环：若上次重拉未逃逸
/// （explorer 未运行等），本次回退到常规缺失处理（复位 installed 走安装流程）。
#[cfg(windows)]
fn relaunch_via_shell_escape(app_handle: &tauri::AppHandle) {
    let marker = relaunch_marker_path(app_handle);
    if marker.exists() {
        let _ = std::fs::remove_file(&marker);
        log::warn!("RedirectionGuard(448) relaunch did not escape, falling back to normal missing handling");
        return;
    }
    let _ = std::fs::write(&marker, b"1");
    let Ok(exe) = std::env::current_exe() else {
        log::warn!("RedirectionGuard(448) detected but current_exe unavailable, falling back");
        return;
    };
    match std::process::Command::new("explorer.exe").arg(&exe).spawn() {
        Ok(_) => {
            log::warn!(
                "RedirectionGuard(448) detected, relaunching via explorer to escape enforced context: {}",
                exe.display()
            );
            // 短暂让出后退出，避免与新实例产生单实例冲突
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(0);
        }
        Err(e) => {
            log::warn!(
                "RedirectionGuard(448) detected but explorer spawn failed ({e}), falling back"
            );
        }
    }
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的入口：本地核心存在时优先本地（需求 3），否则预打包
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
        // Windows RedirectionGuard(448)：安装器继承的强制执行上下文永不自行恢复，
        // 先尝试通过 explorer 逃逸重拉（见 relaunch_via_shell_escape 注释），
        // 成功则本进程退出；未命中（重拉未逃逸/非 448）才走常规缺失处理。
        #[cfg(windows)]
        if dsh_bin_open_error(&app_handle) == Some(448) {
            relaunch_via_shell_escape(&app_handle);
        }
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.installed = false;
        config::set_store_dat_setting(&app_handle, setting);
        // 状态变更需要 info 级落盘：这是「store 显示未安装」的源头之一
        // （核心文件短暂缺失被复位），自更新后自动重开走进安装分支多由此触发。
        log::info!("Runtime files missing (node/dsh), resetting installed flag");
        return Ok(());
    }

    if has_owned_process() {
        log::info!("Owned Harness process is already running");
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    // 清理 RedirectionGuard(448) 逃逸重拉标记：本进程正常走到启动说明处于干净上下文，
    // 移除标记保证下次自更新后仍能触发逃逸重拉。
    #[cfg(windows)]
    let _ = std::fs::remove_file(relaunch_marker_path(&app_handle));

    log::info!("Starting Harness service");
    status::set_status(status::Status::Starting);
    status::emit_status(&app_handle);
    launch(app_handle).await?;
    // 之后由 scheduler/task/tick_check_dsh_process/mod.rs 检测状态

    Ok(())
}

/// 重启 Harness 服务
pub async fn restart(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Restarting Harness service");

    // 1. 停止现有服务
    stop(app_handle.clone()).await?;

    // 2. 重新启动
    start(app_handle).await?;

    Ok(())
}

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的 dsh 入口（本地核心优先，未检测到走预打包）
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    log::debug!("Checking Node.js path: {:?}", node_binary_path);
    if !node_binary_path.exists() {
        log::error!("Node.js not installed");
        return Err("NODE_NOT_FOUND: Node.js not installed".to_string());
    }
    log::debug!("Checking Harness path: {:?}", dsh_binary_path);
    if !dsh_binary_path.exists() {
        log::error!("Harness not installed");
        return Err("HARNESS_NOT_FOUND: Harness not installed".to_string());
    }

    // 避免重复启动（配合启动守卫，确保并发调用只拉起一个进程）
    if has_owned_process() {
        log::info!("Owned Harness process is already running, skipping launch");
        return Ok(());
    }
    if LAUNCH_GUARD
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!("Harness launch already in progress, skipping");
        return Ok(());
    }
    let _launch_guard = LaunchGuard;

    // 端口自愈：自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口，
    // 在回落目标（用户手动端口 manual_port，否则默认端口）空闲时回落，避免
    // 端口只增不减、一路从 3080 漂到 3084+（issue #91）。先于
    // wait_for_port_release 探测：既然放弃旧端口，就无需等它释放。
    let heal_target = setting.manual_port.unwrap_or(config::default_port());
    let healed_port = resolve_heal_port(setting.port, heal_target, !is_port_in_use(heal_target));
    if healed_port != setting.port {
        log::info!(
            "Harness port healed from {} back to {} (no longer occupied)",
            setting.port,
            healed_port
        );
        setting.port = healed_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }

    // 端口冲突时从当前值开始逐个递增，并持久化最终选择供所有调用方复用。
    // 注意：上个会话的残留 dsh 进程刚被我们结束/清扫（sweep_orphan、stop、
    // stop_on_exit），TCP 端口释放存在短暂滞后——此刻立刻探测会把“刚释放的
    // 端口”误判为仍占用，从而把配置端口永久顶高（dev 热更新下 3081→3082→…
    // 一路漂移，表现为“端口持续累加 + 首次启动超时、刷新后恢复”）。先留出
    // 窗口等配置端口回落为空闲，再决定是否真的逐级递增。
    wait_for_port_release(setting.port).await;
    let available_port = find_available_port(setting.port)?;
    if available_port != setting.port {
        log::info!(
            "Harness port changed from {} to {} because the configured port is occupied",
            setting.port,
            available_port
        );
        setting.port = available_port;
        config::set_store_dat_setting(&app_handle, setting.clone());
    }

    // 构造环境变量：隔离的 $DSH_HOME + 隐私默认（关闭遥测）
    let dsh_home = config::get_dsh_data_path(&app_handle);
    fs::create_dir_all(&dsh_home).map_err(|e| format!("create dsh home failed: {e}"))?;

    // Linux 起步前探测 inotify 监视上限：harness 服务（dsh web）用 chokidar 递归
    // 监视 profile 目录，上限过低会在启动一瞬间抛 ENOSPC 直接退出（issue #116）。
    // 进程无法自我调高该参数，这里只做告警（启动日志 + 读取 run logs 中的环境信息），
    // 前端据服务日志的 ENOSPC 特征给出「调高 fs.inotify.max_user_watches」的针对性提示。
    #[cfg(unix)]
    warn_if_inotify_watch_limit_low();

    // Windows 极简模式修复的自愈：插件已装入 profile 时确保 patch 挂载行与
    // minimal-win 用户 preset 落盘（幂等）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 terminal support apply failed: {e}");
    }
    // renderer 的 SlotOutlet 一行导出补丁（dsh-tauri-ui 设置侧边栏依赖）：只补
    // 活动核心的 dsh-client-ui-renderer lib/client.js，已含导出即跳过（幂等；核心
    // 换版本后自动重打，上游官方导出后自动退休）。最佳努力：失败只告警，不阻断
    // 启动——未打补丁时插件侧降级，官方设置 dialog 照常工作，绝不白屏。
    if let Err(e) = renderer_patch::apply(&app_handle) {
        log::warn!("renderer SlotOutlet patch failed: {e}");
    }
    // worktree 会话以隔离 cwd 执行，但产品归属仍是源 Workspace；放宽上游显式
    // attach 的 cwd 相等约束，其他 cwd 有效性校验保持不变。最佳努力且幂等。
    if let Err(e) = workspace_patch::apply(&app_handle) {
        log::warn!("workspace worktree membership patch failed: {e}");
    }
    // 当前 DSH client-HMR 会卸载第三方插件却不重新挂载。debug 直接联接本地
    // 插件源码，故将 rebuilt 降级为自动刷新页面；release 保持上游行为。
    if let Err(e) = client_hmr_patch::apply(&app_handle) {
        log::warn!("debug client plugin reload fallback patch failed: {e}");
    }
    // 预防性处理：pnpm 在无 TTY 环境（dsh-market 等子进程）下重装/更新插件时，
    // 清理/重建 node_modules 会触发交互确认并因无 TTY 直接中止
    // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），表现为插件更新失败。
    // 启动时确保 profile 的 .npmrc 写入 confirmModulesPurge=false（幂等、保留
    // 已有配置）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::ensure_profile_npmrc(&app_handle) {
        log::warn!("ensure profile .npmrc failed: {e}");
    }
    // 内置插件自愈：随包分发的内置插件（dsh-tauri 等）必须在服务进程加载插件
    // 前就绪——核对「已安装 + 安装路径指向当前捆绑目录」，未安装、路径不正确
    // 或用户卸载后重启，一律强制重装（见 service::plugin::internal）。最佳
    // 努力：失败只告警，不阻断启动（核心功能缺失是发布缺陷，由 prebuild 报错）。
    if let Err(e) = crate::service::plugin::ensure_internal_plugins(&app_handle).await {
        log::warn!("ensure internal plugins failed: {e}");
    }
    // 预装插件完整性自检：清单引用的预装插件若在 node_modules 缺失产物，服务
    // 启动时 loader 会对每个缺失插件抛 ERR_MODULE_NOT_FOUND 而整体失败（issue
    // #90，日志特征 `Cannot find package`）。用 `pnpm install` 以现有 manifest +
    // lockfile 为准重建依赖图修复；修复失败只告警并给缺失插件记录错误标记
    // （启动失败场景由前端 recovery 对话框兜底，见 service::plugin::recovery）。
    if let Err(e) = crate::service::plugin::ensure_preset_plugins(&app_handle).await {
        log::warn!("ensure preset plugins failed: {e}");
    }
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "DSH_HOME".to_string(),
        dsh_home.to_string_lossy().into_owned(),
    );
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());
    // 把服务实际使用的 node 路径显式交给子进程（pnpm/dsh shim 的 DSH_NODE
    // 优先）：市场（dsh-market）等子进程经 PATH 解析 node 可能与桌面端预检
    // 不一致（相对 PATH 条目 / junction / 子进程 PATH 布局差异），导致 pnpm
    // shim 报 "Node.js runtime not found"（issue #121，与 build_plugin_envs
    // 的注入保持一致）。先规范化为绝对路径：相对路径在子进程 CWD 下会解析
    // 到错误位置；已存在（上面校验过）的 node 可安全 canonicalize。
    let node_abs =
        std::fs::canonicalize(&node_binary_path).unwrap_or_else(|_| node_binary_path.clone());
    envs.insert(
        "DSH_NODE".to_string(),
        node_abs.to_string_lossy().into_owned(),
    );

    // 扩展 PATH，让 dsh 及其子进程能找到 node 与桌面端自动配置的 Git；Windows
    // 上再注入 Git Bash 的 bin 目录：persistent bash（--noprofile --norc）不执行
    // profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    // 前置应用自身的 shim 目录，使市场（dsh-market）及其子进程通过名字解析的
    // `pnpm`/`dsh` 都命中桌面端 shim，从而受桌面端 pnpm 选版策略管辖
    // （轻量缓解，issue #69 系列）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![crate::service::cli::get_bin_dir(&app_handle)];
            paths.push(node_dir.to_path_buf());
            if let Some(git_dir) = config::get_git_cmd_dir(&app_handle) {
                log::debug!(
                    "harness service Git PATH prepend: {}",
                    git_dir.to_string_lossy()
                );
                paths.push(git_dir);
            }
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // GUI 进程可能启动在 pnpm 安装之前，继承的 PATH 因而没有 npm 全局目录。
    // 直接注入探测到的绝对路径，避免 dsh-market 的 pnpm --version 落到自身 shim
    // 后又因 PATH 看不到真正的 pnpm（issue #139）。
    if let Some(user_pnpm) = crate::service::cli::find_user_pnpm(&app_handle) {
        // Unix mise shim 依赖调用路径中的 argv[0]；只做字面绝对化，不能解析
        // `pnpm -> mise` 链接。Windows 仍由同一辅助函数处理连接点与 `\\?\`。
        if let Some(pnpm_value) = crate::service::cli::pnpm_env_value(
            &user_pnpm,
            &crate::service::cli::get_bin_dir(&app_handle),
        ) {
            envs.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    // 让市场子进程的 pnpm 与桌面端同一套受控策略（store 主版本感知、避免落到系统
    // homebrew pnpm）。与插件安装路径的 ensure_pnpm 版本感知一致，但启动阶段绝不
    // 触发下载；捆绑版未安装或与 store 不匹配时不注入（交由用户 pnpm）。
    // 最佳努力：失败只告警，不阻断启动。
    if crate::service::plugin::harness_prefer_bundled_pnpm(&app_handle) {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    }

    // 日志文件（前端日志面板读取）。
    // 每次真实启动前轮转：只保留最近 3 次启动的日志，旧文件后退为
    // `dsh-web.log.1` / `dsh-web.log.2`，避免单文件随多次启动无限增长。
    let log_path = config::get_service_log_path(&app_handle);
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("create log dir failed: {e}"))?;
    utils::rotate_service_log(&log_path, 3);

    // rc.8 起 `dsh web` 默认在系统浏览器打开 UI；桌面端内嵌 WebView，不需要
    // 浏览器，追加 `--no-open` 关闭（老版本无此标志时按版本判定不传）。
    let no_open = web_supports_no_open_flag(&app_handle);

    log::info!("Starting Harness process");

    // Windows 打包版是 GUI 进程（没有控制台）。直接以 CREATE_NO_WINDOW 启动
    // node 会让 dsh 派生的子进程各自新建可见控制台窗口（频繁闪烁 cmd 黑窗），
    // 因此 Windows 上改用“隐藏控制台”方式启动，见 win_spawn 模块。
    let active_profile = crate::service::profile::active_profile(&app_handle);
    let spawn_result = {
        #[cfg(windows)]
        {
            let mut args: Vec<OsString> = vec![
                dsh_binary_path.as_os_str().to_os_string(),
                OsString::from("--profile"),
                OsString::from(active_profile.as_str()),
                OsString::from("--host"),
                OsString::from("127.0.0.1"),
                OsString::from("--port"),
                OsString::from(setting.port.to_string()),
            ];
            if no_open {
                args.push(OsString::from("--no-open"));
            }
            win_spawn::spawn_with_hidden_console_owned(
                &node_binary_path,
                &args,
                Some(&config::get_dsh_install_path(&app_handle)),
                &envs,
            )
            .map(|(stdout, stderr, pid, handle)| {
                // PID 与句柄作为整体一次登记，与退出清理（take 一并取出）配对
                let handle_value = handle as usize;
                set_owned_process_with_handle(pid, handle_value);
                std::thread::spawn(move || unsafe {
                    use windows_sys::Win32::Foundation::CloseHandle;
                    use windows_sys::Win32::System::Threading::{
                        GetExitCodeProcess, WaitForSingleObject, INFINITE,
                    };
                    let process_handle = handle_value as windows_sys::Win32::Foundation::HANDLE;
                    WaitForSingleObject(process_handle, INFINITE);
                    // 记录退出码：启动即崩溃（插件冲突等）时前端据此快速失败，
                    // 退出码也便于诊断问题
                    let mut exit_code: u32 = 0;
                    if GetExitCodeProcess(process_handle, &mut exit_code) != 0 {
                        log::warn!("Owned Harness process {pid} exited with code {exit_code}");
                    } else {
                        log::warn!("Owned Harness process {pid} exited (exit code unavailable)");
                    }
                    // 进程确已退出：清空持有 PID 并把 Status 从 Running 回落为
                    // Stopped（原有实现只清 PID、状态永远停留在 Running）。
                    // 仅当该 PID 仍是当前登记才取出——旧监视线程不会误清新进程。
                    // take 返回值里的句柄由本线程负责关闭（不会与
                    // terminate_owned_process 重复 close——进程已 exit，
                    // 通常是本线程取走）。
                    let owned = on_owned_process_exit(pid);
                    if let Some(owned) = owned {
                        let h = owned.handle as windows_sys::Win32::Foundation::HANDLE;
                        CloseHandle(h);
                    }
                });
                (Some(stdout), Some(stderr), pid)
            })
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new(&node_binary_path);
            cmd.arg(&dsh_binary_path)
                .arg("--profile")
                .arg(active_profile.as_str())
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(&setting.port.to_string());
            if no_open {
                cmd.arg("--no-open");
            }
            cmd.envs(&envs)
                .current_dir(config::get_dsh_install_path(&app_handle))
                // 核心修正：提供一个空的 stdin 防止 setRawMode 报错
                .stdin(Stdio::null())
                // 使用管道捕获输出，以便在子线程中读取
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                // 独立进程组让停止操作只影响 Harness 及其后代。
                .process_group(0);
            cmd.spawn().map(|mut child| {
                let pid = child.id();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                set_owned_process(pid);
                std::thread::spawn(move || {
                    let code = child.wait().ok().and_then(|status| status.code());
                    // 记录退出码：启动即崩溃（插件冲突等）时前端据此快速失败
                    if let Some(code) = code {
                        log::warn!("Owned Harness process {pid} exited with code {code}");
                    } else {
                        log::warn!("Owned Harness process {pid} exited (no exit code)");
                    }
                    // 进程确已退出：清空持有 PID 并把 Status 从 Running 回落为 Stopped
                    // （Unix 无进程句柄可关闭，忽略返回的进程记录）。
                    // 仅当该 PID 仍是当前登记才取出——旧监视线程不会误清新进程。
                    let _ = on_owned_process_exit(pid);
                });
                (stdout, stderr, pid)
            })
        }
    };

    match spawn_result {
        Ok((stdout, stderr, pid)) => {
            log::info!(
                "Harness process started successfully: pid={pid}, port={}",
                setting.port
            );
            // 记录 PID+端口供下次启动清扫崩溃残留的孤儿实例（见 sweep_orphan_harness）
            persist_harness_pid(&app_handle, pid, setting.port);
            spawn_output_readers(stdout, stderr, log_path);
            Ok(())
        }
        Err(e) => {
            log::error!("Failed to start process: {}", e);
            Err(format!("PROCESS_START_FAILED: {e}"))
        }
    }
}

/// 停止 Harness 服务
pub async fn stop(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Stopping Harness service...");
    // 重置启动守卫，确保后续 launch 可以重新拉起；仅结束持有的根进程树。
    // 进程终止涉及 WaitForSingleObject（至多 5s）与 taskkill/kill 等同步阻塞
    // 调用，移出 Tokio 执行线程避免卡住其他并发任务（WARN-7/P2-#20）。
    LAUNCH_GUARD.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(terminate_owned_process)
        .await
        .map_err(|e| format!("STOP_FAILED: {e}"))?;
    // 清理孤儿清扫标记：正常停止的实例不应被下次启动当作残留
    let _ = fs::remove_file(harness_pid_path(&app_handle));

    // 给系统一点时间释放端口 (重要！)
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    status::set_status(status::Status::Stopped);
    status::emit_status(&app_handle);
    Ok(())
}

/// 应用退出时同步回收 Harness 进程。
///
/// 退出路径上不更新状态、不做异步等待，只结束当前应用持有的 Harness 进程树。
pub fn stop_on_exit(app_handle: tauri::AppHandle, _port: u16) {
    terminate_owned_process();
    // 正常退出路径同样清理清扫标记（崩溃路径才需要下次启动清扫）
    let _ = fs::remove_file(harness_pid_path(&app_handle));
}

/// 安装环境（Node.js 运行时 + 打包的 Harness 发行版 + pnpm；Windows 缺失
/// 系统 Git 时再自动安装免安装 MinGit）。
///
/// 返回是否真正落盘更新了 Harness（dsh 任务实际下载并解压）；仅重装
/// Node/pnpm/Git 或全部任务被跳过时返回 false，供调用方决定是否重启页面。
pub async fn install(
    app_handle: &tauri::AppHandle,
    mut dsh_latest: Option<download::LatestDshPkg>,
) -> Result<bool, String> {
    log::info!("Starting installation process");
    // dsh 任务（index==1）实际下载解压时置 true
    let mut dsh_updated = false;

    // 安装前先停止本应用持有的 Harness 服务：运行中的 node 进程会把
    // 原生模块 DLL（如 sharp 的 libvips-42.dll）加载进内存并锁住文件，
    // 不停止的话覆盖解压必然失败（Windows os error 32）。
    // 进程归属以启动时记录的 PID 为准，不根据端口结束未知程序。
    if has_owned_process() {
        log::info!("Stopping running Harness service before installation");
        stop(app_handle.clone()).await?;
    }
    // 只停本应用持有的进程还不够：历史崩溃/强杀残留的孤儿 Harness 实例
    // （不在 .harness.pid 标记中）同样从 dependencies/dsh 启动、占用目录文件
    // 句柄，会导致更新切换目录失败（INSTALL_BACKUP_FAILED, os error 32）。
    // 按命令行路径精确清扫所有本应用 dsh 安装目录启动的进程。
    // 枚举/结束涉及 powershell 枚举与 taskkill（同步阻塞），移出 Tokio 线程。
    {
        let handle = app_handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            terminate_stale_harness_processes(&handle);
        })
        .await
        .map_err(|e| format!("STOP_FAILED: {e}"))?;
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    log::debug!("Main window obtained");
    let mut tasks: Vec<Box<dyn download::Installable>> = vec![
        Box::new(download::Nodejs),
        Box::new(download::Dsh),
        Box::new(download::Pnpm),
    ];
    // Windows Sandbox 等空白环境没有 Git；仅 Windows 加入第 4 项，若系统 Git
    // 可真实执行则 Installable 会跳过，不重复下载也不修改系统 PATH。
    #[cfg(windows)]
    tasks.push(Box::new(download::Git));
    // 每项均有下载/解压两个阶段，按实际平台任务数计算，避免进度提前到 100%。
    let mut tracker = download::ProgressTracker::new(&window, tasks.len() * 2);
    log::info!("Task list created, {} tasks total", tasks.len());

    for (index, task) in tasks.iter().enumerate() {
        log::debug!("Processing task {}/{}", index + 1, tasks.len());
        // 已安装但版本/commit 与最新 release 不一致时强制重新下载。
        // 版本优先（与 resolve_update 的判定完全一致）：dsh 的 rc 发布会复用
        // 同一 git commit（record_commit 不变），只比 commit 会把 rc.8 之于
        // rc.7 误判为"已最新"而跳过下载——日志表现为"All installation tasks
        // completed"但实际什么都没下载，重启后仍是旧版，且前端丢掉更新提示。
        let outdated = index == 1
            && dsh_latest.as_ref().is_some_and(|info| {
                let installed_version = config::get_dsh_version(app_handle);
                let latest_version = download::parse_version_from_tag(&info.tag);
                // 版本号可解析且不同 → 必须更新；版本不可解析时退回同一发布判定
                let version_differs =
                    match (installed_version.as_deref(), latest_version.as_deref()) {
                        (Some(a), Some(b)) => a != b,
                        _ => false,
                    };
                // 「同一发布」判定与 resolve_update 完全一致：记录 tag 与最新 tag
                // 相同、或记录 commit 与 release 的任一合法标识（完整 SHA / build-id）
                // 一致。限流期安装会把 build-id 写进记录，API 恢复后解析出的完整
                // SHA 与之不等但仍是同一 release，不能据此误判为过期而重下。
                version_differs
                    || !download::record_matches_latest_release(
                        config::get_dsh_pkg_commit(app_handle).as_deref(),
                        config::get_dsh_pkg_tag(app_handle).as_deref(),
                        info,
                    )
            });
        if task.check_installed(app_handle) && !outdated {
            log::debug!(
                "Task {} already installed and up to date, skipping",
                index + 1
            );
            tracker.skip_phases(2);
            continue;
        }

        log::info!("Task {} not installed, starting installation", index + 1);

        // 1. 下载
        tracker.start_phase(
            "download",
            &format!(
                "{} {}",
                config::i18n::t("install.downloading"),
                task.title()
            ),
        );
        // 下载 URL 对 dsh 也是完全确定可算的（DSH_CORE_URL + 平台文件名），
        // 无需依赖 GitHub API 元数据；api.github.com 限流/被代理拦截时
        // （mac 首次启动常见）仍能拿到真实下载地址，避免整次安装被瞬时失败卡死。
        // dsh 核心默认先走 GitHub 官方直连，失败自动切换 ghfast.top 镜像兜底
        // （下载层会在界面上告知用户）；其余任务保持单一官方源。
        let (urls, name) = if index == 1 {
            let urls = config::get_dsh_download_urls()?;
            let name = urls
                .first()
                .and_then(|u| u.rsplit('/').next())
                .unwrap_or("")
                .to_string();
            (urls, name)
        } else {
            let url = task.get_download_url()?;
            let name = url.rsplit('/').next().unwrap_or("").to_string();
            (vec![url], name)
        };
        // 取文件名用于解压类型判定；下载 URL 正常必含 '/'，但这里不 panic，
        // 防御性兜底为空串（后续 ensure_extract 会因无法判定类型而报错返回，
        // 不再让进程崩溃）。
        log::debug!("Download URL: {}", urls.join(" -> "));
        log::debug!("File name: {}", name);
        let buffer = download::download_file_from_sources(&tracker, urls).await?;
        log::info!("Download completed, file size: {} bytes", buffer.len());
        let expected_digest = match index {
            0 => download::fetch_node_sha256(task.get_download_url()?.as_str()).await?,
            1 => {
                // dsh 的 SHA-256 digest 只能来自 GitHub release asset 元数据
                // （安全设计，见 dsh_INTEGRITY_UNAVAILABLE）。首次安装时该元数据
                // 可能因 api.github.com 限流/网络抖动而缺失（mac 首次启动常见，
                // issue #31），这里带退避重取，避免启动被瞬时失败卡死。
                if dsh_latest.is_none() {
                    for attempt in 0..3 {
                        match download::fetch_latest_dsh_pkg_info().await {
                            Ok(info) => {
                                dsh_latest = Some(info);
                                break;
                            }
                            Err(e) if attempt < 2 => {
                                log::warn!(
                                    "Retrying dsh release metadata fetch ({}/3), will retry: {}",
                                    attempt + 1,
                                    e
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    500 * (attempt as u64 + 1),
                                ))
                                .await;
                            }
                            Err(e) => {
                                return Err(format!(
                                    "DSH_INTEGRITY_UNAVAILABLE: 无法获取 Harness 发行版的完整性校验信息（{}），请检查网络后重试",
                                    e
                                ));
                            }
                        }
                    }
                }
                dsh_latest
                    .as_ref()
                    .and_then(|info| info.digest.clone())
                    .ok_or_else(|| {
                        "DSH_INTEGRITY_UNAVAILABLE: trusted release digest is required".to_string()
                    })?
            }
            2 => config::PNPM_SHA256.to_string(),
            #[cfg(windows)]
            3 => config::get_mingit_sha256()?.to_string(),
            _ => return Err("INSTALL_TASK_INVALID: unknown install task".to_string()),
        };
        download::verify_sha256(&buffer, &expected_digest)?;
        log::info!("Download integrity verified for task {}", index + 1);
        tracker.end_phase();

        // 2. 解压
        tracker.start_phase(
            "extract",
            &format!("{} {}", config::i18n::t("install.extracting"), task.title()),
        );
        let dest = task.get_install_path(app_handle);
        log::debug!("Installation path: {:?}", dest);
        download::ensure_extract(&tracker, name, buffer, dest).await?;
        log::info!("Extraction completed");
        tracker.end_phase();

        // 记录本次安装对应的 release tag 与 commit，供下次启动比对
        if index == 1 {
            dsh_updated = true;
            if let Some(info) = &dsh_latest {
                config::set_dsh_pkg_commit(app_handle, info.commit.clone());
                config::set_dsh_pkg_tag(app_handle, info.tag.clone());
            }
        }
    }

    log::info!("All installation tasks completed");
    tracker.update(
        100.0,
        config::i18n::t("install.done"),
        "All tasks completed".into(),
    );

    Ok(dsh_updated)
}

/// 无持有进程时应返回给前端的探测信号。
///
/// `launch` 仍在进行（LAUNCH_GUARD 未释放）时，无持有进程是**临时**状态：`launch`
/// 已抢到守卫、尚未把持有进程登记进槽位（spawn 未完成，典型为 auto_start 与前端
/// boot 并发拉起——前端 `launch_harness` 命中“launch already in progress, skipping”
/// 后立刻来探测，此刻 `wait_for_port_release` 可能仍在等待端口回落）。若把这种
/// 临时状态当作 `HARNESS_NOT_OWNED`，前端会命中快速失败分支（`notOwned` → 立即
/// 放弃重试），表现为“首次启动超时、刷新/重试后恢复”。
///
/// 因此 `launch` 仍在进行时返回可重试的“启动中”（`HARNESS_NOT_READY`），让前端
/// 继续轮询；守卫已释放却仍无持有进程，才是真正崩溃/从未拉起（进程随后退出、槽位
/// 被监视线程清空），返回 `HARNESS_NOT_OWNED` 让前端快速失败，避免把“启动即崩溃”
/// 误判成“启动慢”而白白耗完 8 轮重试。
fn not_owned_probe_signal(launch_in_progress: bool) -> &'static str {
    if launch_in_progress {
        "HARNESS_NOT_READY: Harness service is still starting"
    } else {
        "HARNESS_NOT_OWNED: no Harness process is owned by this app"
    }
}

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
pub async fn proxy_health_check(port: u16) -> Result<String, String> {
    if !has_owned_process() {
        return Err(not_owned_probe_signal(LAUNCH_GUARD.load(Ordering::SeqCst)).to_string());
    }
    let client = utils::loopback_http_client(config::HEALTH_CHECK_TIMEOUT)
        .map_err(|e| format!("HARNESS_HEALTH_CLIENT_FAILED: {e}"))?;
    let mut failures = Vec::with_capacity(2);

    for endpoint in utils::health_probe_plugin_urls(port) {
        match client.get(&endpoint).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if utils::looks_like_plugin_bundle(status.is_success(), &body) {
                    return Ok(format!(
                        "healthy - {status} - {}",
                        body.chars().take(80).collect::<String>()
                    ));
                }
                let failure = format!("{endpoint} returned {status} (not a plugin bundle)");
                log::debug!("Health check failed: {failure}");
                failures.push(failure);
            }
            Err(err) => {
                log::debug!("Health check {endpoint}: {err}");
                failures.push(format!("{endpoint}: {err}"));
            }
        }
    }
    Err(format!(
        "HARNESS_NOT_READY: Harness client plugins are not ready ({})",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn occupied_port_advances_to_a_free_port() {
        let mut checked = Vec::new();
        let selected = find_available_port_by(3080, |port| {
            checked.push(port);
            port < 3082
        })
        .expect("find next free port");

        assert_eq!(selected, 3082);
        assert_eq!(checked, vec![3080, 3081, 3082]);
    }

    #[test]
    fn occupied_port_reports_exhaustion_at_max_port() {
        let error = find_available_port_by(u16::MAX, |_| true).expect_err("port exhaustion");
        assert!(error.starts_with("PORT_EXHAUSTED:"));
    }

    /// 回归：无持有进程在“launch 仍在进行”（守卫未释放）时应返回可重试的
    /// `HARNESS_NOT_READY`，而不是把临时状态当成崩溃的 `HARNESS_NOT_OWNED` —
    /// 后者会让前端命中快速失败分支，表现为“首次启动超时、刷新/重试后恢复”。
    #[test]
    fn not_owned_is_retryable_during_launch_not_fatal() {
        // launch 仍在进行（守卫未释放）：无持有进程是启动中的临时状态，前端继续轮询
        assert!(not_owned_probe_signal(true).starts_with("HARNESS_NOT_READY"));
        // 启动已结束（守卫释放）却仍无持有进程：进程已退出/从未拉起 → 快速失败
        assert!(not_owned_probe_signal(false).starts_with("HARNESS_NOT_OWNED"));
    }

    /// 模拟“上个会话残留进程刚被杀、端口仍在释放”的场景：先占用端口，随后在
    /// 另一线程释放。验证 `wait_for_port_release` 在端口回落后立即返回，而不是
    /// 等到完整等待窗口——这正是避免端口永久顶高（dev 热更新下 3081→3082→…）
    /// 的关键行为。
    #[tokio::test]
    async fn wait_for_port_release_returns_shortly_after_port_is_released() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind held test port");
        let held = listener.local_addr().expect("read held port").port();

        // 端口此刻确实被占用（模拟残留进程仍在监听）
        assert!(is_port_in_use(held));
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(listener);
        });

        let started = std::time::Instant::now();
        wait_for_port_release(held).await;
        // 端口 150ms 后释放 + 80ms 轮询间隔，应远小于 1.5s 等待上限
        assert!(
            started.elapsed() < std::time::Duration::from_millis(800),
            "wait_for_port_release should return shortly after the port is released, not wait the full window"
        );
        assert!(!is_port_in_use(held));
    }

    #[test]
    fn no_open_supported_on_rc8_and_later() {
        assert!(version_supports_no_open("0.1.0-rc.8"));
        assert!(version_supports_no_open("0.1.0-rc.9"));
        // 基础版本更大的新版本：0.1.1-rc.1 的 rc 号（1）虽小于 8，但晚于
        // 0.1.0-rc.8，同样支持 --no-open（只比 rc 号会把这里误判为旧版）
        assert!(version_supports_no_open("0.1.1-rc.1"));
        assert!(version_supports_no_open("0.1.2-rc.1"));
        // 稳定版必然晚于 rc.8
        assert!(version_supports_no_open("0.1.0"));
        assert!(version_supports_no_open("0.2.0"));
        assert!(version_supports_no_open("1.0.0"));
    }

    #[test]
    fn no_open_absent_before_rc8() {
        assert!(!version_supports_no_open("0.1.0-rc.7"));
        assert!(!version_supports_no_open("0.1.0-rc.0"));
        // 基础版本更早的 rc 系列一律不支持
        assert!(!version_supports_no_open("0.0.1-rc.5"));
        assert!(!version_supports_no_open("0.0.9-rc.99"));
    }

    #[test]
    fn no_open_unknown_version_is_conservative() {
        assert!(!version_supports_no_open(""));
        // rc 号缺失：`0.1.0-rc` 的预发布 [rc] 短于 [rc, 8]，判为早于 rc.8
        assert!(!version_supports_no_open("0.1.0-rc"));
        // 不完整/非法版本号（缺 patch、带 v 前缀、无 semver 结构）：无法解析
        assert!(!version_supports_no_open("0.1"));
        assert!(!version_supports_no_open("v0.1.0"));
        assert!(!version_supports_no_open("not-a-version"));
    }

    /// 构造一个测试用 `OwnedProcess`（跨平台处理 Windows 句柄字段）。
    #[cfg(windows)]
    fn test_owned(pid: u32) -> OwnedProcess {
        OwnedProcess { pid, handle: 0 }
    }
    #[cfg(not(windows))]
    fn test_owned(pid: u32) -> OwnedProcess {
        OwnedProcess { pid }
    }

    /// 退出监视线程只能清掉「与自己 PID 匹配」的登记，不许误清刚启动的新进程，
    /// 也不许重复取出（幂等）。回归 WARN-6 合并引入的回退。
    #[test]
    fn owned_process_take_if_only_matches_pid() {
        // 匹配的 PID 才可取出，且取走后槽清空
        let mut slot = Some(test_owned(42));
        let taken = take_owned_process_if_matching(&mut slot, 42);
        assert_eq!(taken.map(|p| p.pid), Some(42));
        assert!(slot.is_none());

        // PID 不匹配（旧进程 41 退出）时禁止取出/清空新进程（新进程 42）
        let mut slot = Some(test_owned(42));
        let taken = take_owned_process_if_matching(&mut slot, 41);
        assert!(taken.is_none());
        assert_eq!(slot.as_ref().map(|p| p.pid), Some(42));

        // 幂等：已清空后再次取出返回 None
        let mut slot: Option<OwnedProcess> = None;
        assert!(take_owned_process_if_matching(&mut slot, 42).is_none());
    }

    /// 端口自愈（issue #91）：自动避让递增遗留的非默认端口，在回落目标空闲时
    /// 回落到目标（默认端口或用户手动端口），回落目标被占时维持当前端口。
    #[test]
    fn heal_port_returns_target_when_free() {
        // 自动递增遗留 3084，默认 3080 空闲 → 回落默认端口
        assert_eq!(resolve_heal_port(3084, 3080, true), 3080);
        // 用户手动 9090 空闲 → 回落用户值
        assert_eq!(resolve_heal_port(9091, 9090, true), 9090);
    }

    #[test]
    fn heal_port_keeps_current_when_target_busy_or_aligned() {
        // 回落目标被占 → 维持当前端口（留给 find_available_port 逐级递增）
        assert_eq!(resolve_heal_port(3084, 3080, false), 3084);
        // 当前端口即回落目标（已是最优）→ 不变
        assert_eq!(resolve_heal_port(3080, 3080, true), 3080);
        assert_eq!(resolve_heal_port(3080, 3080, false), 3080);
    }

    /// `ps -axo pid=,command=` 行解析：首列 PID，其余为命令行。
    #[test]
    fn parse_ps_line_extracts_pid_and_cmdline() {
        // `.lines()` 迭代已去掉行尾换行
        let (pid, cmdline) =
            parse_ps_line("   12345 node /path/to/bin.js --profile web").expect("parse ps line");
        assert_eq!(pid, 12345);
        assert_eq!(cmdline, "node /path/to/bin.js --profile web");
        // 多列空白（PID 与命令之间多个空格）+ 行首空白
        let (pid, cmdline) = parse_ps_line("  67890    sh  -c  sleep 1").expect("parse ps line");
        assert_eq!(pid, 67890);
        assert_eq!(cmdline, "sh  -c  sleep 1");
    }

    #[test]
    fn parse_ps_line_skips_invalid_rows() {
        // 无空白分隔（纯 PID）→ 无法取命令行，跳过
        assert!(parse_ps_line("12345").is_none());
        // PID 不可解析（可能是表头残留）→ 跳过
        assert!(parse_ps_line("PID COMMAND").is_none());
        // 空行 → 跳过
        assert!(parse_ps_line("").is_none());
    }

    /// 命令行匹配：argv 整词精确等于 dsh 入口路径才算本应用服务实例。
    #[test]
    fn harness_cmdline_matches_service_arguments() {
        let bin = "/home/u/.dsh/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        assert!(is_harness_command_line(
            &format!("node {bin} --profile web --host 127.0.0.1 --port 3083"),
            bin
        ));
    }

    #[test]
    fn harness_cmdline_matches_macos_app_data_path_with_spaces() {
        let bin = "/Users/simon/Library/Application Support/io.github.hairyf.deepseek-harness-desktop/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        let cmdline =
            format!("/opt/homebrew/bin/node {bin} --profile web --host 127.0.0.1 --port 3084");
        assert!(is_harness_command_line(&cmdline, bin));
    }

    #[test]
    fn harness_cmdline_rejects_foreign_and_prefix_paths() {
        let bin = "/home/u/.dsh/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        // 用户其它 node 程序
        assert!(!is_harness_command_line(
            "node /usr/bin/some-server.js",
            bin
        ));
        // 路径前缀相似但不同（整词匹配，不做子串匹配）
        assert!(!is_harness_command_line(
            "node /home/u/.dsh/dependencies/dsh-extra/tool.js",
            bin
        ));
        // 完整路径只是另一参数的前缀时不能命中
        assert!(!is_harness_command_line(
            &format!("node {bin}.backup --profile web --host 127.0.0.1 --port 3083"),
            bin
        ));
        // 同一 dsh 入口执行插件命令时不是 Harness 服务，不能清扫
        assert!(!is_harness_command_line(
            &format!("node {bin} plugin list"),
            bin
        ));
        // 路径作为另一个参数的后缀时不能命中
        assert!(!is_harness_command_line(
            &format!("node prefix{bin} --host 127.0.0.1 --port 3083"),
            bin
        ));
        // 空命令行
        assert!(!is_harness_command_line("", bin));
    }

    /// 回归（issue #91）：Unix 上 `kill_pid_tree` 对「无独立进程组」的进程
    /// 必须回退到直接杀 PID——否则手动 CLI 拉起的外围 dsh 永远杀不掉，
    /// 残留进程持续占用端口导致端口一路递增。
    #[cfg(unix)]
    #[test]
    fn kill_pid_tree_falls_back_to_direct_pid_kill() {
        // 子进程不设独立进程组（模拟手动拉起的外围 dsh）；2 秒后自然退出，
        // 若 kill_pid_tree 未能杀死它，wait 会等到 2 秒后自然退出 → 超时断言失败
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 2")
            .spawn()
            .expect("spawn sleep child");
        let pid = child.id();
        // 给子进程一点时间进入 sleep，确保信号发到的是 sleep 而非刚 fork 的 sh
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        kill_pid_tree(pid);
        let status = child.wait().expect("wait for child");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(1500),
            "child should have been killed by kill_pid_tree, not waited for natural exit"
        );
        // 被信号杀死：success() 为 false（SIGTERM 143 / SIGKILL 137）
        assert!(!status.success());
    }

    /// 正常路径：根进程在独立进程组中（与启动时 `process_group(0)` 对应），
    /// 负 PID 组信号应能结束整个进程树。
    #[cfg(unix)]
    #[test]
    fn kill_pid_tree_kills_process_group() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 2")
            .process_group(0)
            .spawn()
            .expect("spawn group child");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        kill_pid_tree(pid);
        let status = child.wait().expect("wait for group child");
        assert!(started.elapsed() < std::time::Duration::from_millis(1500));
        assert!(!status.success());
    }
}
