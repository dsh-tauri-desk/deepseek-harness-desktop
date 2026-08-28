//! 桌面应用的系统登录启动集成。
//!
//! 跨平台注册交给 Tauri 官方插件；Windows 只补齐其底层库对缺失注册表键和
//! 重复禁用不幂等的问题，并清理由任务管理器维护的残留状态。

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

#[cfg(windows)]
use std::io::ErrorKind;
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
const RUN_REGISTRY_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const STARTUP_APPROVED_REGISTRY_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/// 返回系统启动项名称；开发版独立命名，避免覆盖正式版的可执行文件路径。
pub fn app_name() -> &'static str {
    if cfg!(debug_assertions) {
        "Deepseek Harness Desktop Dev"
    } else {
        "Deepseek Harness Desktop"
    }
}

#[cfg(windows)]
fn windows_run_entry_exists(name: &str) -> Result<bool, String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match current_user.open_subkey_with_flags(RUN_REGISTRY_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    };
    match run_key.get_raw_value(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    }
}

#[cfg(windows)]
fn ensure_windows_run_key() -> Result<(), String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_REGISTRY_KEY)
        .map(|_| ())
        .map_err(|error| format!("AUTOSTART_REGISTRY_FAILED: {error}"))
}

#[cfg(windows)]
fn remove_windows_startup_approval(name: &str) -> Result<(), String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let key =
        match current_user.open_subkey_with_flags(STARTUP_APPROVED_REGISTRY_KEY, KEY_SET_VALUE) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
        };
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    }
}

/// 从系统读取当前登录启动状态，允许用户在系统设置中直接修改它。
pub fn is_enabled<R: Runtime>(app_handle: &AppHandle<R>) -> Result<bool, String> {
    #[cfg(windows)]
    if !windows_run_entry_exists(app_name())? {
        return Ok(false);
    }

    app_handle
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("AUTOSTART_STATUS_FAILED: {error}"))
}

/// 写入登录启动状态并复查结果，禁用操作保持幂等。
pub fn set_enabled<R: Runtime>(app_handle: &AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let manager = app_handle.autolaunch();
    if enabled {
        #[cfg(windows)]
        ensure_windows_run_key()?;
        manager
            .enable()
            .map_err(|error| format!("AUTOSTART_ENABLE_FAILED: {error}"))?;
    } else {
        #[cfg(windows)]
        {
            if windows_run_entry_exists(app_name())? {
                manager
                    .disable()
                    .map_err(|error| format!("AUTOSTART_DISABLE_FAILED: {error}"))?;
            }
            remove_windows_startup_approval(app_name())?;
        }
        #[cfg(not(windows))]
        manager
            .disable()
            .map_err(|error| format!("AUTOSTART_DISABLE_FAILED: {error}"))?;
    }

    let actual = is_enabled(app_handle)?;
    if actual != enabled {
        return Err(format!(
            "AUTOSTART_STATE_MISMATCH: requested {enabled}, actual {actual}"
        ));
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use auto_launch::{AutoLaunch, AutoLaunchBuilder};
    use std::path::PathBuf;

    #[cfg(windows)]
    use super::{
        ensure_windows_run_key, remove_windows_startup_approval, windows_run_entry_exists,
        RUN_REGISTRY_KEY,
    };
    #[cfg(windows)]
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    #[cfg(windows)]
    use winreg::RegKey;

    const TEST_APP_NAME: &str = "Deepseek Harness Desktop Autostart Test";

    struct AutostartCleanup {
        manager: AutoLaunch,
    }

    impl Drop for AutostartCleanup {
        fn drop(&mut self) {
            let _ = clear_test_entry(&self.manager);
        }
    }

    fn test_manager() -> (AutoLaunch, PathBuf) {
        let executable = std::env::current_exe().expect("test executable path should be available");
        let manager = AutoLaunchBuilder::new()
            .set_app_name(TEST_APP_NAME)
            .set_app_path(executable.to_string_lossy().as_ref())
            .set_use_launch_agent(true)
            .build()
            .expect("test autostart manager should build");
        (manager, executable)
    }

    #[cfg(windows)]
    fn clear_test_entry(manager: &AutoLaunch) -> Result<(), String> {
        ensure_windows_run_key()?;
        if windows_run_entry_exists(TEST_APP_NAME)? {
            manager
                .disable()
                .map_err(|error| format!("AUTOSTART_TEST_CLEANUP_FAILED: {error}"))?;
        }
        remove_windows_startup_approval(TEST_APP_NAME)
    }

    #[cfg(not(windows))]
    fn clear_test_entry(manager: &AutoLaunch) -> Result<(), String> {
        manager
            .disable()
            .map_err(|error| format!("AUTOSTART_TEST_CLEANUP_FAILED: {error}"))
    }

    fn round_trip() -> (AutostartCleanup, PathBuf) {
        let (manager, executable) = test_manager();
        clear_test_entry(&manager).expect("stale test autostart entry should be removed");
        let cleanup = AutostartCleanup { manager };

        assert!(
            !cleanup
                .manager
                .is_enabled()
                .expect("disabled state should be readable"),
            "test autostart entry should start disabled"
        );
        cleanup
            .manager
            .enable()
            .expect("test autostart entry should enable");
        assert!(
            cleanup
                .manager
                .is_enabled()
                .expect("enabled state should be readable"),
            "test autostart entry should be enabled"
        );

        (cleanup, executable)
    }

    fn finish_round_trip(cleanup: &AutostartCleanup) {
        clear_test_entry(&cleanup.manager).expect("test autostart entry should disable");
        assert!(
            !cleanup
                .manager
                .is_enabled()
                .expect("disabled state should be readable"),
            "test autostart entry should be disabled"
        );
        clear_test_entry(&cleanup.manager).expect("repeated disable should be idempotent");
    }

    #[cfg(windows)]
    #[test]
    fn windows_autostart_registration_round_trip() {
        let (cleanup, executable) = round_trip();
        let value: String = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_REGISTRY_KEY, KEY_READ)
            .expect("Windows Run key should be readable")
            .get_value(TEST_APP_NAME)
            .expect("test Run value should exist");
        assert!(
            value.contains(executable.to_string_lossy().as_ref()),
            "Run value should contain the current test executable"
        );
        finish_round_trip(&cleanup);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_autostart_registration_round_trip() {
        let (cleanup, executable) = round_trip();
        let plist = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME should be available")
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{TEST_APP_NAME}.plist"));
        let content =
            std::fs::read_to_string(&plist).expect("LaunchAgent plist should be readable");
        assert!(content.contains(&format!("<string>{TEST_APP_NAME}</string>")));
        assert!(content.contains(&format!("<string>{}</string>", executable.display())));
        let status = std::process::Command::new("plutil")
            .args(["-lint", plist.to_string_lossy().as_ref()])
            .status()
            .expect("plutil should run");
        assert!(status.success(), "LaunchAgent plist should be valid");
        finish_round_trip(&cleanup);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_autostart_registration_round_trip() {
        let (cleanup, executable) = round_trip();
        let desktop_entry = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME should be available")
            .join(".config")
            .join("autostart")
            .join(format!("{TEST_APP_NAME}.desktop"));
        let content =
            std::fs::read_to_string(desktop_entry).expect("desktop entry should be readable");
        assert!(content.contains(&format!("Name={TEST_APP_NAME}")));
        assert!(content.contains(&format!("Exec={}", executable.display())));
        finish_round_trip(&cleanup);
    }
}
