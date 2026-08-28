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
fn windows_run_entry_exists() -> Result<bool, String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match current_user.open_subkey_with_flags(RUN_REGISTRY_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    };
    match run_key.get_raw_value(app_name()) {
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
fn remove_windows_startup_approval() -> Result<(), String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let key =
        match current_user.open_subkey_with_flags(STARTUP_APPROVED_REGISTRY_KEY, KEY_SET_VALUE) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
        };
    match key.delete_value(app_name()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    }
}

/// 从系统读取当前登录启动状态，允许用户在系统设置中直接修改它。
pub fn is_enabled<R: Runtime>(app_handle: &AppHandle<R>) -> Result<bool, String> {
    #[cfg(windows)]
    if !windows_run_entry_exists()? {
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
            if windows_run_entry_exists()? {
                manager
                    .disable()
                    .map_err(|error| format!("AUTOSTART_DISABLE_FAILED: {error}"))?;
            }
            remove_windows_startup_approval()?;
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

#[cfg(all(test, windows))]
mod tests {
    use super::{
        app_name, ensure_windows_run_key, remove_windows_startup_approval, windows_run_entry_exists,
    };
    use auto_launch::AutoLaunch;

    /// 真实读写当前用户启动项；默认忽略，需在 Windows 上显式运行。
    #[test]
    #[ignore = "mutates and restores the current user's Windows autostart entry"]
    fn windows_autostart_registration_round_trip() {
        ensure_windows_run_key().expect("Windows Run key should be available");
        let executable = std::env::current_exe().expect("test executable path should be available");
        let executable = executable.to_string_lossy();
        let args: [&str; 0] = [];
        let manager = AutoLaunch::new(app_name(), executable.as_ref(), &args);
        let initially_enabled = manager
            .is_enabled()
            .expect("initial autostart state should be readable");

        let result = (|| -> Result<(), String> {
            manager.enable().map_err(|error| error.to_string())?;
            if !manager.is_enabled().map_err(|error| error.to_string())? {
                return Err("autostart should be enabled after registration".to_string());
            }

            manager.disable().map_err(|error| error.to_string())?;
            remove_windows_startup_approval()?;
            if windows_run_entry_exists()? {
                return Err("autostart entry should be removed after disabling".to_string());
            }
            Ok(())
        })();

        // 无论断言结果如何，都恢复测试前状态，避免污染开发机。
        if initially_enabled {
            manager
                .enable()
                .expect("initial autostart state should restore");
        } else {
            if windows_run_entry_exists().unwrap_or(false) {
                manager
                    .disable()
                    .expect("temporary autostart entry should be removed");
            }
            remove_windows_startup_approval()
                .expect("temporary task manager state should be removed");
        }
        result.expect("Windows autostart registration should round-trip");
    }
}
