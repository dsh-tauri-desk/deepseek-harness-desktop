//! Harness 进程生命周期：本应用持有的根进程登记（PID + Windows 句柄成对存储）、
//! 启动守卫、进程树终止与退出状态回落，以及按 dsh 安装路径清扫历史残留的
//! 孤儿服务实例（release 构建；debug 由各自 AppData 下的 `.harness.pid` 标记精确回收）。

use crate::config;
use std::fs;
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::status;
use super::sweep::harness_pid_path;

/// 当前持有的 Harness 根进程意外退出时通知前端的专用事件。
pub(super) const HARNESS_PROCESS_EXITED_EVENT: &str = "harness-process-exited";

/// Harness 根进程退出事件载荷。退出码在 Unix 被信号终止或系统查询失败时为空。
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessProcessExitedPayload {
    pub(super) pid: u32,
    pub(super) exit_code: Option<i64>,
}

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
pub(crate) static LAUNCH_GUARD: AtomicBool = AtomicBool::new(false);

/// 当前进程内由桌面端创建的 Harness 根进程（PID + Windows 句柄）。
///
/// PID 与句柄装在同一把锁的可选值里：`take()` 一次性成对取出，保证
/// 「PID 清空」与「句柄关闭」之间不存在跨原子竞态（WARN-6）。历史上 PID/句柄
/// 分两个 `Atomic*` 存储，`stop` 读 PID 与监视线程清句柄之间有微窗口可能导致
/// 漏杀或重复 close。
#[derive(Clone, Copy)]
pub(super) struct OwnedProcess {
    pub(super) pid: u32,
    /// Windows 进程句柄（原始 HANDLE 转 usize 存储，避免 `*mut c_void` 非 Send）。
    /// 只在 Windows 存在；Unix 无句柄概念。
    #[cfg(windows)]
    pub(super) handle: usize,
}

fn owned_process_lock() -> &'static Mutex<Option<OwnedProcess>> {
    static OWNED_PROCESS: OnceLock<Mutex<Option<OwnedProcess>>> = OnceLock::new();
    OWNED_PROCESS.get_or_init(|| Mutex::new(None))
}

/// 记录新持有的 Harness 根进程（Unix，启动成功后调用）。
#[cfg(not(windows))]
pub(super) fn set_owned_process(pid: u32) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid });
}

/// 若调用方 owns 该进程（Windows 额外存句柄），记录之。
#[cfg(windows)]
pub(super) fn set_owned_process_with_handle(pid: u32, handle: usize) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid, handle });
}

/// 原子取出持有的进程（PID+句柄一起）。取走者负责关闭 Windows 句柄；
/// 无条件取出（停止/退出路径）。
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

pub(crate) struct LaunchGuard;

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCH_GUARD.store(false, Ordering::SeqCst);
    }
}

/// 核心目录操作互斥锁：统一串行化「切换目录」与「启动并登记进程」两个临界区。
///
/// 不能只用一个布尔守卫：两个并发切换可能互相覆盖/清除状态，且 launch 在检查
/// 守卫与登记进程之间仍存在窗口。使用同一把 Tokio mutex 后，切换从停服到目录
/// 互换完成、launch 从最终状态检查到进程登记均保持互斥，避免 Harness 进程在
/// `dependencies/dsh` 目录交换期间加载 DLL 并产生 Windows os error 32。
fn core_transition_lock() -> &'static Arc<tokio::sync::Mutex<()>> {
    static LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
}

/// 获取核心目录操作互斥锁，最长等待 15 秒。
///
/// 调用方必须从获取锁开始，持续持有到目录切换完成或 Harness 进程登记完成；
/// RAII guard 会在所有成功/失败路径自动释放。超时必须失败返回，避免切换或启动
/// 卡死后永久阻塞后续所有核心操作。
pub async fn acquire_core_transition() -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    const CORE_TRANSITION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    tokio::time::timeout(
        CORE_TRANSITION_TIMEOUT,
        Arc::clone(core_transition_lock()).lock_owned(),
    )
    .await
    .map_err(|error| {
        format!(
            "CORE_TRANSITION_TIMEOUT: timed out after {} seconds waiting for core transition lock: {error}",
            CORE_TRANSITION_TIMEOUT.as_secs()
        )
    })
}

/// 是否持有 Harness 进程。与其它访问器一致：锁被毒化（panic 残留）时取回
/// 毒化守卫继续读取，而不是把「已登记进程」误报为「无」。
pub fn has_owned_process() -> bool {
    owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

/// 处理「持有的 dsh 进程退出」这一事实（由退出监视线程与健康检查 tick 共用）：
///
/// - 仅当退出的 PID 仍是当前登记的那个进程时才清空持有（`take_owned_process_if`
///   按 pid 匹配），PID/句柄作为整体成对取出——杜绝「读 PID」与「清句柄」
///   之间的跨原子竞态（WARN-6），也杜绝旧监视线程误清新启动进程的登记；
/// - 匹配成功后无条件回落到 Stopped——进程可能在 Starting 或 Running 阶段
///   退出，任何情况下都不能继续广播一个已经失效的运行状态（WARN-5）。
///
/// 返回被取出的进程记录（含 Windows 句柄），取到者负责 `CloseHandle`——保证
/// 「取走进程」与「关闭句柄」同属一个调用者，杜绝重复 close。幂等：多次调用
/// （tick 与监视线程并发）只会生效一次，后续调用返回 None。
pub(super) fn on_owned_process_exit(
    app_handle: &AppHandle,
    pid: u32,
    exit_code: impl FnOnce(&OwnedProcess) -> Option<i64>,
) -> Option<OwnedProcess> {
    let owned = take_owned_process_if(pid)?;
    // 必须在成功取走当前 PID 后才读取 Windows 句柄：正常停止会先取走并关闭
    // 句柄，旧监视线程不得再查询该句柄，更不得发送“意外退出”事件。
    let exit_code = exit_code(&owned);

    if let Some(code) = exit_code {
        log::warn!(
            "Owned Harness process {} exited with code {code}; resetting status to Stopped",
            owned.pid
        );
    } else {
        log::warn!(
            "Owned Harness process {} exited (exit code unavailable); resetting status to Stopped",
            owned.pid
        );
    }

    status::set_status(status::Status::Stopped);
    status::emit_status(app_handle);
    let payload = HarnessProcessExitedPayload {
        pid: owned.pid,
        exit_code,
    };
    if let Err(error) = app_handle.emit(HARNESS_PROCESS_EXITED_EVENT, payload) {
        log::warn!("Failed to emit Harness process exit event: {error}");
    }
    Some(owned)
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
pub(crate) fn kill_pid_tree(pid: u32) {
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
        // 与 is_harness_command_line 一致，额外要求服务参数（--host 127.0.0.1
        // 与 --port），避免误伤用户并行执行的 `dsh plugin` 等短命令。
        let escaped = dsh_bin.replace('\'', "''");
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {{ $_.CommandLine -like '*{escaped}*' -and $_.CommandLine -like '*--host 127.0.0.1*' -and $_.CommandLine -like '*--port*' }} | Select-Object -ExpandProperty ProcessId"
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
pub(super) fn warn_if_inotify_watch_limit_low() {
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 退出载荷保留退出码（含 0），无法取得时显式序列化为 null。
    #[test]
    fn harness_process_exit_payload_serializes_exit_code() {
        let with_code = serde_json::to_value(HarnessProcessExitedPayload {
            pid: 42,
            exit_code: Some(0),
        })
        .expect("serialize process exit payload");
        assert_eq!(with_code, serde_json::json!({ "pid": 42, "exitCode": 0 }));

        let without_code = serde_json::to_value(HarnessProcessExitedPayload {
            pid: 43,
            exit_code: None,
        })
        .expect("serialize process exit payload");
        assert_eq!(
            without_code,
            serde_json::json!({ "pid": 43, "exitCode": null })
        );
    }

    /// 核心转换锁可被多个异步操作按顺序获取，避免两个切换重叠。
    #[tokio::test]
    async fn core_transition_lock_serializes_operations() {
        let first = acquire_core_transition()
            .await
            .expect("first transition lock should be acquired");
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            acquire_core_transition(),
        )
        .await;
        assert!(second.is_err());
        drop(first);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            acquire_core_transition()
        )
        .await
        .expect("transition lock should be available after release")
        .is_ok());
    }

    /// 两个切换请求不能重叠：第一个释放转换锁后，第二个才可进入。
    #[tokio::test]
    async fn overlapping_switches_are_serialized() {
        let first = acquire_core_transition()
            .await
            .expect("first transition lock should be acquired");
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);
        let waiter = tokio::spawn(async move {
            let _second = acquire_core_transition().await;
            entered_tx
                .send(())
                .await
                .expect("notify second switch entry");
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), entered_rx.recv())
                .await
                .is_err()
        );
        drop(first);
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("second switch should enter after first releases")
            .expect("second switch task should complete");
    }

    /// 启动请求不能在切换持锁期间进入：切换完成后启动才可进入并完成登记阶段。
    #[tokio::test]
    async fn launch_and_switch_overlap_is_serialized() {
        let switch_guard = acquire_core_transition()
            .await
            .expect("switch transition lock should be acquired");
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);
        let launcher = tokio::spawn(async move {
            let _launch_guard = acquire_core_transition().await;
            // 模拟启动完成进程登记后才释放转换锁。
            entered_tx
                .send(())
                .await
                .expect("notify launch registration");
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), entered_rx.recv())
                .await
                .is_err()
        );
        drop(switch_guard);
        tokio::time::timeout(std::time::Duration::from_millis(100), launcher)
            .await
            .expect("launch should enter after switch releases")
            .expect("launch task should complete");
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
