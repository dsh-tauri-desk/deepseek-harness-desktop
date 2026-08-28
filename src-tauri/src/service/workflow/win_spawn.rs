//! Windows 专用：以隐藏控制台的方式启动子进程。
//!
//! 打包版应用是 GUI 进程（没有控制台）。如果直接以 `CREATE_NO_WINDOW` 启动
//! node.exe，node 自身没有控制台，dsh 在 JS 里通过 `child_process` 派生的
//! 每个子进程（cmd / node / git 等）都会各自创建一个新的可见控制台窗口，
//! 表现为使用过程中频繁闪烁黑色 cmd 窗口。
//!
//! 这里改用 `CREATE_NEW_CONSOLE` + `STARTF_USESHOWWINDOW`/`SW_HIDE` 给 node
//! 分配一个隐藏的控制台：node 及其所有后代进程共享这个隐藏控制台，不再弹窗。
//! 模块声明处已按 `#[cfg(windows)]` 门控，仅在 Windows 构建中编译。

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::{
    CloseHandle, SetHandleInformation, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetProcessId, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// 以隐藏控制台方式启动 `program`，返回其 stdout / stderr 管道读取端。
///
/// `envs` 中的键值会覆盖当前进程环境变量后传给子进程。
#[cfg_attr(not(test), allow(dead_code))]
pub fn spawn_with_hidden_console(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File)> {
    let (stdout, stderr, handle) =
        spawn_with_hidden_console_tracked(program, args, current_dir, envs)?;
    unsafe {
        CloseHandle(handle);
    }
    Ok((stdout, stderr))
}

/// 启动由桌面端持有的 Harness 进程，同时返回 PID 与进程句柄。
///
/// PID 用于只结束本应用创建的进程树；句柄由调用方等待并关闭，避免进程退出后
/// PID 被系统复用时误伤其他程序。
pub fn spawn_with_hidden_console_owned(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File, u32, HANDLE)> {
    let (stdout, stderr, handle) =
        spawn_with_hidden_console_tracked(program, args, current_dir, envs)?;
    let pid = unsafe { GetProcessId(handle) };
    if pid == 0 {
        unsafe {
            CloseHandle(handle);
        }
        return Err(io::Error::last_os_error());
    }
    Ok((stdout, stderr, pid, handle))
}

/// 同 [`spawn_with_hidden_console`]，但额外返回进程句柄，供调用方等待进程
/// 结束并读取退出码（预装插件安装等需要判断成败的场景）。
pub fn spawn_with_hidden_console_tracked(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File, HANDLE)> {
    unsafe {
        // 1. 创建 stdout / stderr 匿名管道（写端可继承，交给子进程）
        let pipe_attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };

        let mut stdout_read: HANDLE = std::ptr::null_mut();
        let mut stdout_write: HANDLE = std::ptr::null_mut();
        if CreatePipe(&mut stdout_read, &mut stdout_write, &pipe_attrs, 0) == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut stderr_read: HANDLE = std::ptr::null_mut();
        let mut stderr_write: HANDLE = std::ptr::null_mut();
        if CreatePipe(&mut stderr_read, &mut stderr_write, &pipe_attrs, 0) == 0 {
            CloseHandle(stdout_read);
            CloseHandle(stdout_write);
            return Err(io::Error::last_os_error());
        }

        // 读取端留在父进程，禁止被子进程继承
        SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

        // 2. stdin 指向 NUL，避免 dsh 尝试 setRawMode 时报错
        let mut nul = "NUL".encode_utf16().collect::<Vec<u16>>();
        nul.push(0);
        let stdin_handle = CreateFileW(
            nul.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if stdin_handle == INVALID_HANDLE_VALUE {
            CloseHandle(stdout_read);
            CloseHandle(stdout_write);
            CloseHandle(stderr_read);
            CloseHandle(stderr_write);
            return Err(io::Error::last_os_error());
        }
        SetHandleInformation(stdin_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        // 3. 组装命令行、环境块与启动参数
        let mut command_line = build_command_line(program, args);
        let env_block = build_env_block(envs);

        let mut application_name = program.as_os_str().encode_wide().collect::<Vec<u16>>();
        application_name.push(0);

        let mut current_dir_wide: Option<Vec<u16>> = None;
        if let Some(dir) = current_dir {
            let mut wide = dir.as_os_str().encode_wide().collect::<Vec<u16>>();
            wide.push(0);
            current_dir_wide = Some(wide);
        }

        let startup_info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES,
            wShowWindow: SW_HIDE as u16,
            hStdInput: stdin_handle,
            hStdOutput: stdout_write,
            hStdError: stderr_write,
            ..Default::default()
        };

        let mut process_info = PROCESS_INFORMATION::default();

        let created = CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // bInheritHandles
            CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr() as *const core::ffi::c_void,
            current_dir_wide
                .as_ref()
                .map(|wide| wide.as_ptr())
                .unwrap_or(std::ptr::null()),
            &startup_info,
            &mut process_info,
        );

        // 无论成功与否，父进程都要关闭自己持有的写端和临时句柄
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);
        CloseHandle(stdin_handle);

        if created == 0 {
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            return Err(io::Error::last_os_error());
        }

        // 进程句柄不再需要时由调用方负责关闭（tracked 调用方等待退出后关闭；
        // 非 tracked 由包装函数立即关闭）。关闭线程句柄避免泄漏
        CloseHandle(process_info.hThread);

        let stdout = File::from_raw_handle(stdout_read as RawHandle);
        let stderr = File::from_raw_handle(stderr_read as RawHandle);
        Ok((stdout, stderr, process_info.hProcess))
    }
}

/// 构建完整的 Unicode 环境块（每个条目以 `\0` 结尾，整个块以额外 `\0` 结尾）
fn build_env_block(extra: &HashMap<String, String>) -> Vec<u16> {
    let vars: Vec<(OsString, OsString)> = crate::service::env::environment_with_explicit(extra)
        .into_iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)))
        .collect();

    let mut block = Vec::new();
    for (key, value) in vars {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// 构建 CreateProcessW 命令行（遵循 MSVC 的引号转义规则）
fn build_command_line(program: &Path, args: &[OsString]) -> Vec<u16> {
    let mut command = quote_arg(&program.as_os_str().to_string_lossy());
    for arg in args {
        command.push(' ');
        command.push_str(&quote_arg(&arg.to_string_lossy()));
    }
    let mut wide = command.encode_utf16().collect::<Vec<u16>>();
    wide.push(0);
    wide
}

/// 按 MSVC 规则为命令行参数加引号并转义反斜杠/双引号
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '"')) {
        return arg.to_string();
    }

    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..backslashes * 2 {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('\\');
                out.push('"');
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(c);
            }
        }
    }
    for _ in 0..backslashes * 2 {
        out.push('\\');
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_key_match_is_case_insensitive() {
        // Windows 用户环境里的键通常是 `Path`：用 `PATH` 覆盖必须替换而不是追加
        let mut vars: Vec<(OsString, OsString)> = vec![
            (OsString::from("Path"), OsString::from("OLD")),
            (OsString::from("DSH_HOME"), OsString::from("x")),
        ];
        let key = OsString::from("PATH");
        let found = vars
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(&key));
        assert!(found.is_some());
        if let Some(entry) = found {
            entry.1 = OsString::from("NEW");
        }
        // 替换后仍是单个 Path 条目且取新值
        let path_entries: Vec<String> = vars
            .iter()
            .filter(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("path"))
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(path_entries.len(), 1);
        assert_eq!(path_entries[0], "NEW");
    }

    #[test]
    fn spawn_captures_stdout_with_env_and_workdir() {
        let mut envs = HashMap::new();
        envs.insert("DSH_HOME".to_string(), "hello world".to_string());

        let workdir =
            std::env::temp_dir().join(format!("dsh_win_spawn_test_{}", std::process::id()));
        std::fs::create_dir_all(&workdir).unwrap();

        let args = vec![
            OsString::from("/d"),
            OsString::from("/c"),
            OsString::from("echo %DSH_HOME% && cd"),
        ];
        let (stdout, _stderr) = spawn_with_hidden_console(
            Path::new("C:\\Windows\\System32\\cmd.exe"),
            &args,
            Some(&workdir),
            &envs,
        )
        .unwrap();

        let mut output_bytes = Vec::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_end(&mut output_bytes).unwrap();
        let output = String::from_utf8_lossy(&output_bytes);

        std::fs::remove_dir_all(&workdir).ok();

        assert!(output.contains("hello world"), "stdout: {output:?}");
        assert!(
            output.contains(&workdir.to_string_lossy().into_owned()),
            "stdout: {output:?}"
        );
    }

    #[test]
    fn spawned_process_gets_hidden_console() {
        let script = "$code='using System;using System.Runtime.InteropServices;public class C{[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}';Add-Type -TypeDefinition $code;$h=[C]::GetConsoleWindow();if($h -eq [IntPtr]::Zero){'NO_CONSOLE'}else{'HAS_CONSOLE_VISIBLE='+[C]::IsWindowVisible($h)}";

        let args = vec![
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-Command"),
            OsString::from(script),
        ];
        let (stdout, _stderr) = spawn_with_hidden_console(
            Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            &args,
            None,
            &HashMap::new(),
        )
        .unwrap();

        let mut output = String::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_string(&mut output).unwrap();

        assert!(
            output.contains("HAS_CONSOLE_VISIBLE=False"),
            "expected a hidden console, got: {output:?}"
        );
    }

    #[test]
    fn grandchildren_inherit_hidden_console() {
        let node = find_node_on_path().expect("node.exe not found for the test");
        let ps1 =
            std::env::temp_dir().join(format!("dsh_console_check_{}.ps1", std::process::id()));
        std::fs::write(
            &ps1,
            "$code='using System;using System.Runtime.InteropServices;public class C{[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}';Add-Type -TypeDefinition $code;$h=[C]::GetConsoleWindow();if($h -eq [IntPtr]::Zero){'NO_CONSOLE'}else{'HAS_CONSOLE_VISIBLE='+[C]::IsWindowVisible($h)}",
        )
        .unwrap();

        // node 作为“dsh 代理”：用 child_process 派生一个 powershell 孙进程，
        // 旧实现（node 无控制台）下孙进程会新建可见控制台窗口。
        let node_js = format!(
            "const{{spawnSync}}=require('child_process');const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File','{}'],{{encoding:'utf8'}});process.stdout.write((r.stdout??'')+(r.stderr??''));",
            ps1.to_string_lossy().replace('\\', "/")
        );

        let args = vec![OsString::from("-e"), OsString::from(node_js)];
        let (stdout, stderr) =
            spawn_with_hidden_console(&node, &args, None, &HashMap::new()).unwrap();

        let mut output = String::new();
        let mut error = String::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_string(&mut output).unwrap();
        let mut reader = stderr;
        reader.read_to_string(&mut error).unwrap();
        std::fs::remove_file(&ps1).ok();

        assert!(
            output.contains("HAS_CONSOLE_VISIBLE=False"),
            "expected grandchildren to inherit a hidden console, got: {output:?} stderr: {error:?}"
        );
    }

    fn find_node_on_path() -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}
