//! Windows 注册表辅助：`HKCU\Environment\Path` 读写、`WM_SETTINGCHANGE` 广播
//! 与 PATH token 展开/匹配。仅 Windows 编译（`mod registry` 已在 mod.rs 门控）。

/// 将 Rust 字符串转为 Win32 API 需要的 NUL 结尾 UTF-16 缓冲
#[inline]
pub(super) fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(super) fn read_user_path() -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            log::warn!("failed to open HKCU\\Environment (error {ret})");
            return None;
        }

        let value_name = to_wide_null("Path");
        let mut value_type: u32 = 0;
        let mut size: u32 = 0;
        let mut ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );

        if ret == ERROR_FILE_NOT_FOUND {
            RegCloseKey(hkey);
            return Some(String::new());
        }
        if ret != ERROR_MORE_DATA && ret != 0 {
            RegCloseKey(hkey);
            log::warn!("failed to query HKCU\\Environment\\Path (error {ret})");
            return None;
        }

        let mut buf = vec![0u16; (size as usize / 2).max(1) + 1];
        ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            log::warn!("failed to read HKCU\\Environment\\Path (error {ret})");
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

pub(super) fn write_user_path(new_value: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            return Err(format!(
                "REG_OPEN_FAILED: failed to open HKCU\\Environment (error {ret})"
            ));
        }

        let value_name = to_wide_null("Path");
        let mut value_type: u32 = REG_EXPAND_SZ;
        let mut size: u32 = 0;
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );
        if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
            value_type = REG_EXPAND_SZ;
        }

        let wide_value = to_wide_null(new_value);
        let bytes = (wide_value.len() * 2) as u32;
        let ret = RegSetValueExW(
            hkey,
            value_name.as_ptr(),
            0,
            value_type,
            wide_value.as_ptr() as *const u8,
            bytes,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            return Err(format!(
                "REG_WRITE_FAILED: failed to write HKCU\\Environment\\Path (error {ret})"
            ));
        }
        Ok(())
    }
}

pub(super) fn notify_environment_change() {
    use windows_sys::Win32::Foundation::{LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let wide = to_wide_null("Environment");
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0 as WPARAM,
            wide.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG,
            5000,
            std::ptr::null_mut(),
        );
    }
}

/// 展开字符串中的 `%VAR%`（Windows）
fn expand_env(value: &str) -> String {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    let wide = to_wide_null(value);
    let mut buf = vec![0u16; 32768];
    let n = unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if n == 0 || n > buf.len() as u32 {
        return value.to_string();
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// PATH 值（`;` 分隔）中是否已包含指定目录（大小写不敏感，先展开 %VAR%）
pub(super) fn path_contains_token(path_value: &str, token: &str) -> bool {
    let expanded = expand_env(path_value);
    let token_lower = token.to_lowercase();
    expanded
        .split(';')
        .any(|p| !p.is_empty() && p.trim_end_matches('\\').to_lowercase() == token_lower)
}

/// 从 PATH 值中移除指定目录 token（同时处理 `%LOCALAPPDATA%` 未展开形式）
pub(super) fn remove_path_token(path_value: &str, token: &str) -> String {
    let token_lower = token.to_lowercase();
    let unexpanded_lower = token_lower.replace(
        &std::env::var("LOCALAPPDATA")
            .unwrap_or_default()
            .to_lowercase(),
        "%localappdata%",
    );
    let kept: Vec<&str> = path_value
        .split(';')
        .filter(|p| {
            if p.is_empty() {
                return false;
            }
            let norm = p.trim_end_matches('\\').to_lowercase();
            norm != token_lower && norm != unexpanded_lower
        })
        .collect();
    kept.join(";")
}
