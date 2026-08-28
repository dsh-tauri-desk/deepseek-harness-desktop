//! 安装包下载、完整性校验与交付系统处理器打开。
//!
//! 下载源策略：先取 `expanded_assets` 页面的 SHA-256 摘要作为完整性凭据，再选择
//! 下载源——镜像兜底（ghfast.top）仅在已取得可信摘要时才可使用，否则宁可失败，
//! 防止第三方镜像投毒未被察觉；官方 GitHub 直连在摘要缺失时仍可按旧行为下载，
//! 下载后若有摘要则强制校验。

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::service::workflow;

use super::meta::{fetch_latest_release, LatestRelease};
use super::version::current_version;
use super::{DOWNLOAD_TIMEOUT_SECS, UPDATES_DIR};

/// 安装包存放路径（AppData/updates/<asset_name>）
fn installer_path(app_handle: &AppHandle, asset_name: &str) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("UPDATE_DIR: {e}"))?
        .join(UPDATES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    Ok(dir.join(asset_name))
}

/// 检查是否有桌面端新版本。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    /// 最新可用版本号（无 `v` 前缀）
    pub version: String,
    /// 当前已安装版本号（无 `v` 前缀）
    pub current_version: String,
    pub tag: String,
    pub published_at: String,
    pub url: String,
    pub asset_name: String,
    pub path: String,
    pub downloaded: bool,
}

/// 检查是否有新版本可用（含安装包是否已下载）
pub async fn check(app_handle: &AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    match fetch_latest_release().await? {
        None => Ok(None),
        Some(r) => {
            let path = installer_path(app_handle, &r.asset_name)?;
            let downloaded = path.exists();
            Ok(Some(DesktopUpdateInfo {
                version: r.version,
                current_version: current_version(),
                tag: r.tag,
                published_at: r.published_at,
                url: r.url,
                asset_name: r.asset_name,
                path: path.to_string_lossy().into_owned(),
                downloaded,
            }))
        }
    }
}

/// 下载进度载荷（前端进度条展示）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDownloadProgress {
    pub percentage: f64,
    pub downloaded: u64,
    pub total: u64,
    /// 附加提示（如切换下载源），无提示时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 从单个下载源流式下载安装包到临时文件；失败时清理半成品（避免残留
/// 部分字节被误判为「已下载」）。
async fn download_from_source(
    client: &reqwest::Client,
    url: &str,
    tmp: &std::path::Path,
    app_handle: &AppHandle,
) -> Result<(), String> {
    log::info!("Downloading desktop installer from {}", url);
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;

    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(tmp).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    use std::io::Write;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("UPDATE_FILE: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "desktop-update-progress",
            DesktopDownloadProgress {
                percentage: pct,
                downloaded,
                total,
                message: None,
            },
        );
    }
    drop(file);
    Ok(())
}

/// 安装包下载客户端：长超时（安装包可达数百 MB，慢镜像需要更久），
/// 与检查更新用的 5s `http_client()` 区分。
fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))
}

/// 组装安装包下载源列表：官方 GitHub 直连 + （存在可信摘要时）ghfast.top 镜像。
///
/// 安全策略：第三方镜像没有独立信任根，仅在其内容可被 SHA-256 校验（摘要已取得）
/// 时才提供兜底；否则只允许官方直连，宁可在官方不可用时失败，也不冒投毒风险。
fn download_sources(release: &LatestRelease) -> Vec<String> {
    let mut urls = vec![release.url.clone()];
    if release.digest.is_some() {
        urls.push(config::mirror_download_url(&release.url));
    }
    urls
}

/// 为下载完成的安装包补充可执行权限（Linux AppImage 必需）。
///
/// 下载时 `File::create` 默认生成 `0644`，AppImage 经 `xdg-open` / 直接执行时
/// 需要可执行位，否则表现为「下载成功但无法打开安装包」（issue #79）。这里
/// 在安装包落到最终路径后再补充 `0755`，Linux 上天然生效；macOS 一并设置
/// 无害；Windows 无此概念，忽略。
#[cfg(unix)]
fn ensure_installer_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("UPDATE_FILE: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    Ok(())
}

/// 流式校验安装包文件的 SHA-256。
///
/// 安装包可达数百 MB，先 `std::fs::read` 整块读进内存再校验会翻倍占用内存；
/// 这里按块流式喂给 `Sha256`，完成时仅保留 32 字节摘要。摘要格式接受
/// `sha256:<64hex>` 或裸 `<64hex>`（统一转小写比较）。
fn verify_installer_sha256(path: &std::path::Path, expected: &str) -> Result<(), String> {
    use sha2::Digest;
    use std::io::Read;
    let expected = expected
        .strip_prefix("sha256:")
        .unwrap_or(expected)
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("INTEGRITY_METADATA_INVALID: expected SHA-256 is invalid".to_string());
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("UPDATE_FILE: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "INTEGRITY_CHECK_FAILED: SHA-256 mismatch, expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// 下载桌面端安装包；已下载则直接返回。
///
/// 下载期间通过 `desktop-update-progress` 事件推送进度；完成后返回
/// `DesktopUpdateInfo`（path/downloaded 已更新）。
///
/// 下载源策略：先取 `expanded_assets` 页面的 SHA-256 摘要作为完整性凭据，再
/// 选择下载源——**镜像兜底（ghfast.top）仅在已取得可信摘要时才可使用**，否则
/// 宁可失败，防止第三方镜像投毒未被察觉；官方 GitHub 直连在摘要缺失时仍可
/// 按旧行为下载（兼容早期未填摘要的发布），下载后若有摘要则强制校验。
pub async fn download(app_handle: &AppHandle) -> Result<DesktopUpdateInfo, String> {
    let release = fetch_latest_release()
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())?;
    let path = installer_path(app_handle, &release.asset_name)?;

    if path.exists() {
        log::info!("Installer already downloaded: {}", path.display());
        return check(app_handle)
            .await?
            .ok_or_else(|| "UPDATE_NONE".to_string());
    }

    let client = download_client()?;

    // 官方直连 → （可选）ghfast.top 镜像兜底。安装包无 SHA-256 元数据，切换源时
    // 丢弃上一源的部分字节从头下载，避免混用两个源的字节流。
    // 安全策略：镜像兜底要求已有可信摘要，否则不提供镜像（宁可失败）。
    let urls = download_sources(&release);
    if urls.len() == 1 {
        log::warn!(
            "No SHA-256 digest available for {}, mirror fallback disabled",
            release.asset_name
        );
    }
    let tmp = path.with_extension("part");
    let mut last_err = String::new();
    for (index, url) in urls.iter().enumerate() {
        if index > 0 {
            // 走镜像仅在存在可信摘要时发生（见上方 urls 组装）
            let host = reqwest::Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| url.clone());
            log::warn!(
                "Primary desktop update source failed, switching to fallback: {}",
                url
            );
            let _ = app_handle.emit(
                "desktop-update-progress",
                DesktopDownloadProgress {
                    percentage: 0.0,
                    downloaded: 0,
                    total: 0,
                    message: Some(format!("主下载源不可用，已切换镜像源重试（{host}）")),
                },
            );
        }
        // 先写临时文件再原子改名，避免下载中断残留半成品被误判为「已下载」
        let _ = std::fs::remove_file(&tmp);
        match download_from_source(&client, url, &tmp, app_handle).await {
            Ok(()) => {
                last_err.clear();
                break;
            }
            Err(e) => last_err = e,
        }
    }
    if !last_err.is_empty() {
        return Err(format!(
            "UPDATE_DOWNLOAD: {last_err}（已尝试 {} 个下载源）",
            urls.len()
        ));
    }

    // 完整性校验：摘要存在（镜像路径必有）则强制校验，校验失败即拒绝，
    // 不保留为可安装文件，也不能被 open_installer 打开。流式校验避免整块读入内存。
    if let Some(digest) = &release.digest {
        if let Err(e) = verify_installer_sha256(&tmp, digest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("UPDATE_DOWNLOAD: {e}"));
        }
        log::info!("Installer SHA-256 verified for {}", release.asset_name);
    }

    std::fs::rename(&tmp, &path).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    // Linux 下为安装包补充可执行位（AppImage 需要），否则会「下载成功但无法打开」
    #[cfg(unix)]
    ensure_installer_executable(&path)?;

    check(app_handle)
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())
}

/// 打开安装包：交给系统默认处理器（Windows 会触发 UAC 执行安装器）。
///
/// 安全边界：仅允许打开 `AppData/updates/` 目录内、且文件名与资产名一致的
/// 安装包——任意路径、绝对/相对遍历、`..` 都会拒绝，避免被伪装的 frame 或
/// 插件利用去执行任意文件。
pub async fn open_installer(app_handle: &AppHandle, path: String) -> Result<(), String> {
    let updates_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("UPDATE_DIR: {e}"))?
        .join(UPDATES_DIR);
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_file() {
        return Err(format!("UPDATE_NOT_FOUND: {path}"));
    }
    // 规范化后必须仍在 updates 目录内（防 `..`、符号链接、路径穿越）。
    // 用 `dunce::canonicalize`（std `fs::canonicalize`）——它返回的路径不带
    // Windows `\\?\` verbatim 前缀，`starts_with` 与日志展示更一致。
    let canonical = dunce::canonicalize(p).map_err(|e| format!("UPDATE_OPEN: {e}"))?;
    let updates_real = dunce::canonicalize(&updates_dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    if !canonical.starts_with(&updates_real) {
        log::error!(
            "Rejecting open_installer outside updates dir: {} (root {})",
            canonical.display(),
            updates_real.display()
        );
        return Err(
            "UPDATE_PATH_REJECTED: installer path is outside updates directory".to_string(),
        );
    }
    log::info!("Opening desktop installer: {}", p.display());
    // 更新前先停下本应用持有的 Harness 服务：安装器在安装时会强杀桌面端进程
    // （CheckIfAppIsRunning → taskkill），跳过正常退出路径的 stop_on_exit，导致
    // Harness 子进程变成孤儿继续占用配置端口。若此刻不提前停掉，更新后新实例
    // 启动会撞上 EADDRINUSE（旧 Harness 仍占着端口），表现为「更新后进不去」。
    // 提前停止 → 端口释放并清掉 .harness.pid 标记，更新后启动即可绑定原端口。
    // 仅在确有持有进程时才停（stop 在无持有进程时也会短暂等待端口释放，白耗
    // 约 0.8s）；停止失败只告警不阻断——它是避免端口冲突的辅助手段，打开失败
    // 另有 UPDATE_OPEN 的错误提示。
    if workflow::has_owned_process() {
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("Failed to stop Harness before opening installer: {}", e);
        }
    }
    // 兜底补充可执行权限：兼容老版本下载的 AppImage（0644）被打包用户留存，
    // 直接打开仍会失败；此处幂等修复后再交给系统处理器。
    #[cfg(unix)]
    ensure_installer_executable(p)?;
    app_handle
        .opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("UPDATE_OPEN: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 下载后补充可执行位：下载默认 0644 的文件被修复为含可执行位（issue #79）。
    #[cfg(unix)]
    #[test]
    fn ensure_installer_executable_sets_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("dsh-update-exec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("installer.AppImage");
        std::fs::write(&file, b"payload").unwrap();
        // 模拟下载默认权限 0644
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        ensure_installer_executable(&file).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "应包含所有者/组/其他可执行位，mode={mode:o}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 镜像兜底策略回归：无摘要时只有官方源；有摘要时才加入镜像。
    #[test]
    fn download_sources_only_mirrors_with_digest() {
        let url = "https://github.com/x/y/releases/download/v0.7.4/x.dmg";
        let base = LatestRelease {
            version: "0.7.4".into(),
            tag: "v0.7.4".into(),
            published_at: String::new(),
            url: url.into(),
            asset_name: "x.dmg".into(),
            digest: None,
        };
        // 无摘要 → 仅官方直连
        let without = download_sources(&base);
        assert_eq!(without.len(), 1);
        assert_eq!(without[0], url);
        // 有摘要 → 官方 + 镜像
        let with_digest = LatestRelease {
            digest: Some(format!("sha256:{}", "b".repeat(64))),
            ..base.clone()
        };
        let sources = download_sources(&with_digest);
        assert_eq!(sources.len(), 2);
        assert!(
            sources[1].contains("ghfast.top"),
            "镜像应为 ghfast.top 前缀: {}",
            sources[1]
        );
        assert!(
            sources[1].ends_with("/releases/download/v0.7.4/x.dmg"),
            "镜像保留完整资产路径: {}",
            sources[1]
        );
    }

    /// 流式校验：正确的文件通过、错误的摘要拒绝，且不把整个文件读进内存。
    #[test]
    fn verify_installer_sha256_streams_and_rejects_mismatch() {
        use sha2::Digest;
        let dir = std::env::temp_dir().join(format!("dsh-update-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("installer.part");
        let content = b"deepseek-harness-desktop installer payload";
        std::fs::write(&file, content).unwrap();
        let real = format!("sha256:{}", format!("{:x}", sha2::Sha256::digest(content)));
        // 正确摘要通过
        assert!(verify_installer_sha256(&file, &real).is_ok());
        // 裸 64hex（无 sha256: 前缀）也接受
        assert!(verify_installer_sha256(&file, real.trim_start_matches("sha256:")).is_ok());
        // 错误摘要拒绝
        let wrong = format!("sha256:{}", "0".repeat(64));
        assert!(verify_installer_sha256(&file, &wrong).is_err());
        // 非法摘要格式拒绝
        assert!(verify_installer_sha256(&file, "sha256:zz").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
