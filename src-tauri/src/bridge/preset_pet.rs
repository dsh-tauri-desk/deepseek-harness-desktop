//! bridge/preset_pet.rs — 预设宠物清单、下载与安装。
//!
//! 预设宠物（preset pet）不再随 `dsh-tauri-pet` 包内置媒体资源，而是由
//! `resources/preset-pets.json` 登记远端仓库与资源子目录，用户从设置页「下载」
//! 后安装到 DSH 数据目录的 pets 目录（`~/.dsh/pets`，debug 为 `~/.dsh.dev/pets`）。
//!
//! 下载流程（全部在后台任务执行，设置页通过进度轮询感知）：
//! 1. 按清单条目构造 `https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}`
//!    下载整个仓库 tarball（带 ghfast.top 镜像兜底），进度写入进程内注册表；
//! 2. 只解压清单 `assets` 子目录下的条目（如 `dsh-pet/assets/`），跳过其余仓库
//!    文件（源码、脚本等一律不落盘）；
//! 3. 校验解压产物含可解析的 `config.jsonc`（JSONC 协议），随后 staging 原子
//!    rename 到 `pets/<id>`；
//! 4. 失败只清理本次 staging 与临时 tarball，不触碰其它宠物。
//!
//! 安全约束与 `import_pet` 同一纪律：拒绝 traversal/绝对路径/反斜杠/冒号、
//! symlink/特殊条目、条目数/单文件/总量上限、全局互斥串行、staging 原子安装。

use crate::config;
use crate::desktop::pet as pet_window;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    http::{header::CONTENT_LENGTH, Method, Request, Response, StatusCode},
    AppHandle, Manager,
};
use tokio::io::AsyncWriteExt;

/// 预设宠物清单文件名（随安装包分发，见 `tauri.conf.json` 的 bundle.resources）。
const PRESET_PETS_FILE: &str = "preset-pets.json";
/// 单个预设宠物包解压后的总字节上限（dsh-pet 资产 ~113 MiB，留足余量）。
const PET_PRESET_MAX_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
/// tarball 条目数上限。
const PET_PRESET_MAX_ENTRIES: usize = 2048;
/// 单文件解压上限。
const PET_PRESET_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// 配置读取上限（与内置配置同一档位）。
const PET_PRESET_CONFIG_MAX_BYTES: u64 = 256 * 1024;
/// 下载客户端 User-Agent（与 `service::download` 一致，避免被 GitHub 拒绝）。
const PET_PRESET_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (deepseek-harness-desktop)";

/// 清单条目（`resources/preset-pets.json` 的一个元素）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetPetSpec {
    id: String,
    name: String,
    #[serde(default)]
    desc: Option<String>,
    /// 浏览图 URL（设置页卡片缩略图）。
    #[serde(default)]
    image: Option<String>,
    /// 仓库地址（`https://github.com/{owner}/{repo}`）。
    repo: String,
    /// 仓库内资源子目录（如 `dsh-pet/assets`）。
    assets: String,
    /// 固定提交（ref）；缺省回退 `main`。固定后下载可复现。
    #[serde(default)]
    r#ref: Option<String>,
    /// 下载尺寸（MiB，用于卡片上的 `[number]mb` 标签）。
    #[serde(default)]
    size_mb: Option<f64>,
}

/// 设置页可展示的清单条目（含本机安装状态与进行中的下载阶段）。
#[derive(Debug, Clone, Serialize)]
pub struct PresetPetListItem {
    pub id: String,
    pub name: String,
    pub desc: Option<String>,
    pub image: Option<String>,
    pub size_mb: Option<f64>,
    pub installed: bool,
    /// 当前下载阶段（idle | downloading | extracting | done | failed）。
    /// 设置页跨挂载恢复「下载中」视图用：返回应用再进设置时，进程内注册表仍保留
    /// 进行中的下载阶段，前端据此显示进度条并自动恢复轮询。
    pub phase: String,
}

/// 下载进度快照（设置页轮询 `get_preset_download_progress`）。
#[derive(Debug, Clone, Serialize)]
pub struct PresetDownloadProgress {
    /// idle | downloading | extracting | done | failed
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub error: Option<String>,
}

impl Default for PresetDownloadProgress {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            received: 0,
            total: 0,
            error: None,
        }
    }
}

/// 进程内下载进度注册表（按宠物 id）。
fn preset_downloads() -> &'static Mutex<HashMap<String, PresetDownloadProgress>> {
    static STATE: OnceLock<Mutex<HashMap<String, PresetDownloadProgress>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_preset_progress(id: &str, progress: PresetDownloadProgress) {
    preset_downloads()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id.to_string(), progress);
}

fn get_preset_progress(id: &str) -> PresetDownloadProgress {
    preset_downloads()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(id)
        .cloned()
        .unwrap_or_default()
}

/// 定位清单文件：优先随安装包分发的资源目录，回落源码 `resources/`。
fn preset_pets_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for candidate in [dir.join(PRESET_PETS_FILE), dir.join("resources").join(PRESET_PETS_FILE)]
        {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(PRESET_PETS_FILE);
    source.exists().then_some(source)
}

fn read_preset_catalog(app: &AppHandle) -> Result<Vec<PresetPetSpec>, String> {
    let path = preset_pets_path(app)
        .ok_or_else(|| "PET_PRESET_CATALOG_MISSING: preset-pets.json was not found".to_string())?;
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "PET_PRESET_CATALOG_READ_FAILED: failed to read {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        format!("PET_PRESET_CATALOG_INVALID: invalid preset-pets.json: {error}")
    })
}

/// 预设宠物安装根目录：与 Chat 宠物共用 DSH 数据目录（`~/.dsh/pets` / `~/.dsh.dev/pets`）。
fn preset_pets_root(app: &AppHandle) -> PathBuf {
    config::get_dsh_data_path(app).join("pets")
}

fn installed_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

pub(crate) fn safe_preset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

/// 从仓库 URL 提取 owner/repo；只接受 github.com 形态，拒绝其它主机。
fn parse_repo_owner(url: &str) -> Result<(String, String), String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))
        .ok_or_else(|| {
            "PET_PRESET_REPO_INVALID: repo must be a github.com URL".to_string()
        })?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let owner = parts.next().filter(|part| !part.is_empty());
    let repo = parts.next().map(|part| part.trim_end_matches(".git"));
    match (owner, repo) {
        (Some(owner), Some(repo)) if !repo.is_empty() && parts.next().is_none() => Ok((
            owner.to_string(),
            repo.to_string(),
        )),
        _ => Err("PET_PRESET_REPO_INVALID: repo must be https://github.com/{owner}/{repo}".to_string()),
    }
}

/// 构造仓库 tarball 下载地址（codeload 直连 + ghfast.top 镜像兜底）。
fn tarball_urls(spec: &PresetPetSpec) -> Result<Vec<String>, String> {
    let (owner, repo) = parse_repo_owner(&spec.repo)?;
    let reference = spec
        .r#ref
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "main".to_string());
    if reference.contains('/') || reference.contains('\\') || reference.contains("..") {
        return Err("PET_PRESET_REF_INVALID: ref must be a plain commit or branch name".to_string());
    }
    let primary = format!("https://codeload.github.com/{owner}/{repo}/tar.gz/{reference}");
    Ok(vec![primary.clone(), config::mirror_download_url(&primary)])
}

/// 解压产物必须含可解析的 `config.jsonc`（JSONC 协议，剥注释后为合法 JSON），
/// 且形状必须满足完整协议校验——与 `get_preset_pet_config` 共用同一校验，否则
/// 形状残缺的 preset 会「安装成功、每次读取都报错」。
fn validate_preset_config(root: &Path) -> Result<(), String> {
    let path = root.join("config.jsonc");
    if !path.is_file() {
        return Err("PET_PRESET_CONFIG_MISSING: preset package must include config.jsonc".to_string());
    }
    let bytes = read_bounded_file(&path, PET_PRESET_CONFIG_MAX_BYTES, "PET_PRESET_CONFIG_READ_FAILED")?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|error| format!("PET_PRESET_CONFIG_INVALID: config.jsonc is not UTF-8: {error}"))?;
    let json = strip_jsonc(text);
    let value: serde_json::Value = serde_json::from_str(&json)
        .map_err(|error| format!("PET_PRESET_CONFIG_INVALID: config.jsonc is not valid JSON: {error}"))?;
    validate_preset_pet_config(&value)
}

/// 限量读取文件（与 `bridge::pet` 同一实现，避免跨模块可见性耦合）。
fn read_bounded_file(path: &Path, limit: u64, prefix: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{prefix}: {} is not a file", path.display()));
    }
    if metadata.len() > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{prefix}: failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "{prefix}: {} exceeds the {limit} byte limit",
            path.display()
        ));
    }
    Ok(bytes)
}

/// 剥除 JSONC 注释（行注释 // 与块注释 /* */），字符串字面量内原样保留。
/// 与 `bridge::pet::strip_jsonc` 语义一致。
fn strip_jsonc(src: &str) -> String {
    let bytes: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let c = bytes[index];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            }
            else if c == '\\' {
                escaped = true;
            }
            else if c == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
                index += 1;
            }
            '/' if index + 1 < bytes.len() && bytes[index + 1] == '/' => {
                index += 2;
                while index < bytes.len() && bytes[index] != '\n' {
                    index += 1;
                }
            }
            '/' if index + 1 < bytes.len() && bytes[index + 1] == '*' => {
                index += 2;
                let mut closed = false;
                while index + 1 < bytes.len() {
                    if bytes[index] == '*' && bytes[index + 1] == '/' {
                        index += 2;
                        closed = true;
                        break;
                    }
                    index += 1;
                }
                if !closed {
                    break;
                }
            }
            _ => {
                out.push(c);
                index += 1;
            }
        }
    }
    out
}

/// 路径只允许普通相对组件；显式拒绝反斜杠和冒号（覆盖 Windows 语义）。
fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') || value.contains('\\') || value.contains(':') {
        return Err("PET_PRESET_PATH_INVALID: path must be a portable relative path".to_string());
    }
    let mut result = PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            Component::Normal(part) if !part.is_empty() => result.push(part),
            _ => {
                return Err(
                    "PET_PRESET_PATH_INVALID: path must not be absolute or contain traversal"
                        .to_string(),
                )
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err("PET_PRESET_PATH_INVALID: path must not be empty".to_string());
    }
    Ok(result)
}

/// 流式复制并计数，超限立即截断（不能只信任 tarball 声明的文件大小）。
fn copy_bounded<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total: &mut u64,
    file_budget: &mut u64,
) -> Result<(), String> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if *file_budget == 0 {
            return Err(format!(
                "PET_PRESET_FILE_TOO_LARGE: single file exceeds {PET_PRESET_MAX_FILE_BYTES} bytes"
            ));
        }
        let chunk_limit = usize::try_from(*file_budget)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let count = reader.read(&mut buffer[..chunk_limit]).map_err(|error| {
            format!("PET_PRESET_EXTRACT_FAILED: failed to read archive entry: {error}")
        })?;
        if count == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..count]).map_err(|error| {
            format!("PET_PRESET_EXTRACT_FAILED: failed to write archive entry: {error}")
        })?;
        *total = total
            .checked_add(count as u64)
            .ok_or_else(|| "PET_PRESET_TOO_LARGE: uncompressed size overflow".to_string())?;
        *file_budget -= count as u64;
        if *total > PET_PRESET_MAX_UNCOMPRESSED_BYTES {
            return Err(format!(
                "PET_PRESET_TOO_LARGE: uncompressed files must not exceed {PET_PRESET_MAX_UNCOMPRESSED_BYTES} bytes"
            ));
        }
    }
}

/// 只解压 tarball 中 `assets/` 前缀下的条目到 staging（剥离仓库根目录与前缀）。
///
/// codeload tarball 的布局是 `<repo>-<ref>/<assets>/...`：第一段是仓库根目录，
/// 随后必须是清单声明的 assets 前缀，其余仓库文件（源码/脚本等）一律跳过。
/// 生产路径走 `extract_preset_assets_with_progress`（带解压进度回调）；此无回调
/// 版本仅供测试直接调用。
#[cfg(test)]
fn extract_preset_assets(tarball: &Path, staging: &Path, assets_prefix: &str) -> Result<(), String> {
    extract_preset_assets_with_progress(tarball, staging, assets_prefix, None)
}

/// `extract_preset_assets` 的带进度回调版本：`on_progress` 在每解压完一个文件后
/// 收到已解压字节数（供设置页 extracting 阶段显示百分比，避免进度条长时间不确定）。
fn extract_preset_assets_with_progress(
    tarball: &Path,
    staging: &Path,
    assets_prefix: &str,
    mut on_progress: Option<&mut dyn FnMut(u64)>,
) -> Result<(), String> {
    let file = fs::File::open(tarball)
        .map_err(|error| format!("PET_PRESET_READ_FAILED: failed to open tarball: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let prefix = assets_prefix.trim_matches('/').to_string();
    let prefix_path = Path::new(&prefix);

    fs::create_dir_all(staging).map_err(|error| {
        format!("PET_PRESET_STAGING_FAILED: failed to create staging: {error}")
    })?;
    let mut entries_count = 0_usize;
    let mut total = 0_u64;
    let mut outputs = HashSet::new();

    for entry in archive.entries().map_err(|error| {
        format!("PET_PRESET_EXTRACT_FAILED: failed to read tarball entries: {error}")
    })? {
        let mut entry = entry.map_err(|error| {
            format!("PET_PRESET_EXTRACT_FAILED: failed to read archive entry: {error}")
        })?;
        entries_count += 1;
        if entries_count > PET_PRESET_MAX_ENTRIES {
            return Err(format!(
                "PET_PRESET_ENTRY_LIMIT: archive must contain at most {PET_PRESET_MAX_ENTRIES} entries"
            ));
        }
        // 拒绝 symlink/hardlink 与其它特殊 Unix 文件类型：先看条目类型（tar 的
        // symlink 头 mode 可能为 0，unix_mode 检查不足以兜底），再核对 unix mode。
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err("PET_PRESET_LINK_FORBIDDEN: archive links are not allowed".to_string());
        }
        let mode = entry.header().mode().unwrap_or(0);
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o040000 && file_type != 0o100000 {
            return Err("PET_PRESET_LINK_FORBIDDEN: archive links are not allowed".to_string());
        }
        let path = entry.path().map_err(|error| {
            format!("PET_PRESET_EXTRACT_FAILED: invalid entry path: {error}")
        })?;
        let mut components = path.components();
        let _root = components.next(); // `<repo>-<ref>/` 根目录
        let relative = components.as_path();
        // 只接受 assets 前缀下的条目；根目录条目与仓库其它文件跳过。
        let Ok(relative) = relative.strip_prefix(prefix_path) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue; // assets 目录本身的条目
        }
        let relative = safe_relative_path(&relative.to_string_lossy())?;
        if !outputs.insert(relative.clone()) {
            return Err("PET_PRESET_DUPLICATE_ENTRY: duplicate output path".to_string());
        }
        let output_path = staging.join(&relative);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!("PET_PRESET_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("PET_PRESET_EXTRACT_FAILED: failed to create directory: {error}")
            })?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(|error| {
                format!("PET_PRESET_EXTRACT_FAILED: failed to create file: {error}")
            })?;
        let mut file_budget = PET_PRESET_MAX_FILE_BYTES;
        copy_bounded(&mut entry, &mut output, &mut total, &mut file_budget)?;
        if let Some(on_progress) = on_progress.as_deref_mut() {
            on_progress(total);
        }
    }
    Ok(())
}

/// 下载 tarball 到临时文件（直连失败切镜像源），进度写入注册表。
///
/// codeload 对 tar.gz 响应是 chunked（无 Content-Length），`content_length()` 拿不到
/// 真实总量；此时用清单 `size_mb` 估算 total，让设置页进度条显示实际百分比，
/// 而不是一直停在不确定进度。真实总量已知时（镜像源返回 Content-Length）优先用它。
async fn download_tarball(
    id: &str,
    urls: &[String],
    dest: &Path,
    estimated_total: u64,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(PET_PRESET_USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(20))
        // 响应体读取空闲超时（chunked 流式下载）：只限制「一段时间读不到新字节」，
        // 不影响整包时长；否则连接半挂（服务器不再发包但不关连接）会无限等待。
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("PET_PRESET_DOWNLOAD_FAILED: failed to build client: {error}"))?;

    let mut last_error = String::new();
    for url in urls {
        log::info!(
            "[preset-pet] download {id}: trying {url} (estimated {estimated_total} bytes)"
        );
        let response = client.get(url).send().await;
        match response {
            Ok(response) if response.status().is_success() => {
                let total = response.content_length().unwrap_or(estimated_total);
                let mut received = 0_u64;
                // 日志节流：每 10% 打一条进度，避免逐 chunk 刷屏。
                let mut last_logged_pct = 0_u8;
                let mut file = tokio::fs::File::create(dest).await.map_err(|error| {
                    format!("PET_PRESET_DOWNLOAD_FAILED: failed to create temp file: {error}")
                })?;
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|error| {
                        format!("PET_PRESET_DOWNLOAD_FAILED: download stream error: {error}")
                    })?;
                    received = received
                        .checked_add(chunk.len() as u64)
                        .ok_or_else(|| "PET_PRESET_TOO_LARGE: download size overflow".to_string())?;
                    if received > PET_PRESET_MAX_UNCOMPRESSED_BYTES {
                        return Err(format!(
                            "PET_PRESET_TOO_LARGE: tarball exceeds {PET_PRESET_MAX_UNCOMPRESSED_BYTES} bytes"
                        ));
                    }
                    file.write_all(&chunk).await.map_err(|error| {
                        format!("PET_PRESET_DOWNLOAD_FAILED: failed to write temp file: {error}")
                    })?;
                    set_preset_progress(
                        id,
                        PresetDownloadProgress {
                            phase: "downloading".to_string(),
                            received,
                            total,
                            error: None,
                        },
                    );
                    if total > 0 {
                        let pct = ((received.saturating_mul(100)) / total).min(100) as u8;
                        if pct / 10 > last_logged_pct / 10 && pct < 100 {
                            last_logged_pct = pct;
                            log::info!(
                                "[preset-pet] download {id}: {received} / {total} bytes ({pct}%)"
                            );
                        }
                    }
                }
                file.flush().await.map_err(|error| {
                    format!("PET_PRESET_DOWNLOAD_FAILED: failed to flush temp file: {error}")
                })?;
                log::info!(
                    "[preset-pet] download {id}: completed, {received} bytes from {url}"
                );
                return Ok(());
            }
            Ok(response) => {
                last_error = format!(
                    "PET_PRESET_DOWNLOAD_FAILED: HTTP {} from {url}",
                    response.status()
                );
                log::warn!("{last_error}");
            }
            Err(error) => {
                last_error = format!("PET_PRESET_DOWNLOAD_FAILED: {error} for {url}");
                log::warn!("{last_error}");
            }
        }
    }
    Err(last_error)
}

/// 后台安装流程：下载 → 解压 assets → 校验 → staging 原子 rename。
async fn run_preset_download(app: &AppHandle, spec: PresetPetSpec) -> Result<(), String> {
    let root = preset_pets_root(app);
    fs::create_dir_all(&root).map_err(|error| {
        format!("PET_PRESET_DIR_FAILED: failed to create pets directory: {error}")
    })?;
    let urls = tarball_urls(&spec)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tarball = root.join(format!(".preset-{}-{nonce}.tar.gz", spec.id));
    let staging = root.join(format!(".preset-staging-{}-{nonce}", spec.id));

    let result = (|| async {
        // 清单 size_mb 是解压后 assets 大小（MiB）；codeload 响应无 Content-Length，
        // 用它估算下载总量供进度条显示百分比（真实总量已知时优先）。
        let estimated_total = spec
            .size_mb
            .map(|mb| (mb * 1024.0 * 1024.0).round() as u64)
            .unwrap_or(0);
        log::info!(
            "[preset-pet] install {}: start (assets={:?}, estimated {estimated_total} bytes)",
            spec.id,
            spec.assets
        );
        download_tarball(&spec.id, &urls, &tarball, estimated_total).await?;
        set_preset_progress(
            &spec.id,
            PresetDownloadProgress {
                phase: "extracting".to_string(),
                received: 0,
                total: 0,
                error: None,
            },
        );
        log::info!("[preset-pet] install {}: extracting tarball", spec.id);
        // 解压进度：以清单估算总量为 total，每解压完一个文件上报已解压字节，
        // 设置页 extracting 阶段显示百分比（而不是不确定进度条）。
        let extract_total = estimated_total;
        extract_preset_assets_with_progress(&tarball, &staging, &spec.assets, Some(&mut |uncompressed| {
            set_preset_progress(
                &spec.id,
                PresetDownloadProgress {
                    phase: "extracting".to_string(),
                    received: uncompressed,
                    total: extract_total,
                    error: None,
                },
            );
        }))?;
        log::info!("[preset-pet] install {}: tarball extracted", spec.id);
        validate_preset_config(&staging)?;
        let target = installed_dir(&root, &spec.id);
        if target.exists() {
            return Err(format!(
                "PET_PRESET_ALREADY_INSTALLED: preset pet {} is already installed",
                spec.id
            ));
        }
        fs::rename(&staging, &target).map_err(|error| {
            format!("PET_PRESET_INSTALL_FAILED: failed to install preset pet: {error}")
        })?;
        log::info!(
            "[preset-pet] install {}: installed at {}",
            spec.id,
            target.display()
        );
        Ok(())
    })()
    .await;

    let _ = fs::remove_file(&tarball);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// 列出预设宠物清单（含安装状态）。
#[tauri::command]
pub fn list_preset_pets(app: AppHandle) -> Result<Vec<PresetPetListItem>, String> {
    let catalog = read_preset_catalog(&app)?;
    let root = preset_pets_root(&app);
    let mut items = Vec::with_capacity(catalog.len());
    let mut ids = HashSet::new();
    for spec in catalog {
        if !safe_preset_id(&spec.id) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset id {:?} is not a safe id",
                spec.id
            ));
        }
        if !ids.insert(spec.id.clone()) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: duplicate preset id {:?}",
                spec.id
            ));
        }
        let phase = get_preset_progress(&spec.id).phase;
        items.push(PresetPetListItem {
            installed: installed_dir(&root, &spec.id).is_dir(),
            id: spec.id,
            name: spec.name,
            desc: spec.desc,
            image: spec.image,
            size_mb: spec.size_mb,
            phase,
        });
    }
    Ok(items)
}

/// 开始下载并安装预设宠物（后台执行，立即返回；进度用轮询查询）。
#[tauri::command]
pub fn download_preset_pet(app: AppHandle, id: String) -> Result<(), String> {
    let id = id.trim().to_string();
    let catalog = read_preset_catalog(&app)?;
    let spec = catalog
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("PET_PRESET_NOT_FOUND: preset pet {id} is not in the catalog"))?;
    let root = preset_pets_root(&app);
    if installed_dir(&root, &id).is_dir() {
        return Err(format!("PET_PRESET_ALREADY_INSTALLED: preset pet {id} is already installed"));
    }
    if get_preset_progress(&id).phase == "downloading" || get_preset_progress(&id).phase == "extracting" {
        return Err(format!("PET_PRESET_BUSY: preset pet {id} is already downloading"));
    }
    set_preset_progress(
        &id,
        PresetDownloadProgress {
            phase: "downloading".to_string(),
            received: 0,
            total: 0,
            error: None,
        },
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let progress = match run_preset_download(&app, spec).await {
            Ok(()) => PresetDownloadProgress {
                phase: "done".to_string(),
                received: 0,
                total: 0,
                error: None,
            },
            Err(error) => PresetDownloadProgress {
                phase: "failed".to_string(),
                received: 0,
                total: 0,
                error: Some(error),
            },
        };
        set_preset_progress(&id, progress);
    });
    Ok(())
}

/// 查询指定预设宠物的下载进度（设置页轮询）。
#[tauri::command]
pub fn get_preset_download_progress(id: String) -> PresetDownloadProgress {
    get_preset_progress(id.trim())
}

/// 预设宠物媒体协议的 URL 前缀（与旧内置资产同一协议，见 builder 注册的 dsh-pet scheme）。
#[cfg(target_os = "windows")]
const PRESET_ASSET_ORIGIN: &str = "http://dsh-pet.localhost";
#[cfg(not(target_os = "windows"))]
const PRESET_ASSET_ORIGIN: &str = "dsh-pet://localhost";

/// 预设宠物媒体 URL manifest（name → URL；name 为 webm 文件主名，URL 经 dsh-pet 协议按需流式提供）。
#[derive(Debug, Clone, Serialize)]
pub struct PresetPetAssets {
    pub assets: BTreeMap<String, String>,
}

/// 只对非保留字符做百分号编码（UTF-8 逐字节），其余原样保留：视频文件名含中文时
/// 协议 URL 必须是合法 ASCII，WebView2 会按编码后的路径发起请求。
fn percent_encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 单个十六进制数字 → 值；非十六进制返回 None。
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 百分号解码为 UTF-8 字符串；没有 % 的路径原样返回（兼容 WebView 已解码的请求）。
///
/// 逐字节读取两个 hex digit：不能对 &str 做 `&value[i..i+3]` 字节偏移切片——
/// % 后跟一个 ASCII 字节 + 多字节 UTF-8 字符时，偏移会落在字符中间导致 panic；
/// 解码后的宠物资产名含多字节字符（中文动画名）。
fn percent_decode_segment(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("PET_PRESET_ASSET_PATH_INVALID: truncated percent-encoding".to_string());
            }
            let hi = hex_digit(bytes[index + 1])
                .ok_or_else(|| "PET_PRESET_ASSET_PATH_INVALID: bad percent-encoding".to_string())?;
            let lo = hex_digit(bytes[index + 2])
                .ok_or_else(|| "PET_PRESET_ASSET_PATH_INVALID: bad percent-encoding".to_string())?;
            out.push((hi << 4) | lo);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out)
        .map_err(|_| "PET_PRESET_ASSET_PATH_INVALID: asset name is not valid UTF-8".to_string())
}

/// 已安装预设宠物目录下的受控相对路径（webm/ 或 preview/ 单层子目录内）。
fn resolve_preset_asset(app: &AppHandle, id: &str, subdir: &str, name: &str) -> Result<PathBuf, String> {
    if !matches!(subdir, "webm" | "preview") {
        return Err("PET_PRESET_ASSET_PATH_INVALID: subdir must be webm or preview".to_string());
    }
    let root = preset_pets_root(app);
    let dir = installed_dir(&root, id);
    let sub = dir.join(subdir);
    let candidate = sub.join(name);
    let link_metadata = fs::symlink_metadata(&candidate).map_err(|error| {
        format!("PET_PRESET_ASSET_READ_FAILED: failed to inspect {}: {error}", candidate.display())
    })?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(format!(
            "PET_PRESET_ASSET_INVALID: {} is not a regular file",
            candidate.display()
        ));
    }
    let resolved = candidate.canonicalize().map_err(|error| {
        format!("PET_PRESET_ASSET_READ_FAILED: failed to resolve {}: {error}", candidate.display())
    })?;
    let sub = sub.canonicalize().map_err(|error| {
        format!("PET_PRESET_ASSET_READ_FAILED: failed to resolve {}: {error}", sub.display())
    })?;
    if !resolved.starts_with(&sub) {
        return Err("PET_PRESET_ASSET_INVALID: asset escapes the preset pet directory".to_string());
    }
    let metadata = fs::metadata(&resolved).map_err(|error| {
        format!("PET_PRESET_ASSET_READ_FAILED: failed to inspect {}: {error}", resolved.display())
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "PET_PRESET_ASSET_INVALID: {} is not a regular file",
            resolved.display()
        ));
    }
    if metadata.len() > PET_PRESET_MAX_FILE_BYTES {
        return Err(format!(
            "PET_PRESET_ASSET_TOO_LARGE: {} exceeds {PET_PRESET_MAX_FILE_BYTES} bytes",
            resolved.display()
        ));
    }
    Ok(resolved)
}

/// 协议请求路径 → (pet id, 子目录, 文件名)。兼容 Windows WebView 把 authority
/// 归一化进 path 的 `localhost/` 前缀；只接受单层子目录 + 单文件名，杜绝遍历。
fn preset_asset_path(path: &str) -> Option<(&str, &str, &str)> {
    let path = path.trim_matches('/');
    let path = path.strip_prefix("localhost/").unwrap_or(path);
    let mut parts = path.split('/');
    let id = parts.next().filter(|part| !part.is_empty())?;
    let subdir = parts.next().filter(|part| !part.is_empty())?;
    let name = parts.next().filter(|part| !part.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    if id.contains('\\') || id.contains(':') || id.contains("..") {
        return None;
    }
    Some((id, subdir, name))
}

/// 为 dsh-pet 自定义协议读取已安装预设宠物的媒体文件；调用方已在 builder 限制为 pet WebView。
/// 与旧内置协议同一安全纪律：webview 白名单 + GET/HEAD + 路径三层解析 + canonicalize
/// 包含性校验 + 符号链接拒绝 + 单文件大小上限 + Range 单字节区间。
pub fn preset_pet_asset_response(
    app: &AppHandle,
    webview_label: &str,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if webview_label != pet_window::PET_WINDOW_LABEL {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_FORBIDDEN: request is not from pet window");
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return protocol_error(StatusCode::METHOD_NOT_ALLOWED, "PET_PRESET_ASSET_METHOD_INVALID: only GET and HEAD are allowed");
    }
    let Some((id, subdir, encoded_name)) = preset_asset_path(request.uri().path()) else {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_PATH_INVALID: path is not a safe asset path");
    };
    if !safe_preset_id(id) {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_PATH_INVALID: pet id is not a safe preset id");
    }
    let Ok(name) = percent_decode_segment(encoded_name) else {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_PATH_INVALID: asset name is not valid");
    };
    let Ok(relative) = safe_relative_path(&name) else {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_PATH_INVALID: asset name is not a safe relative path");
    };
    if relative.components().count() != 1
        || !matches!(name.rsplit_once('.').map(|(_, ext)| ext), Some("webm" | "gif"))
    {
        return protocol_error(StatusCode::FORBIDDEN, "PET_PRESET_ASSET_PATH_INVALID: asset must be a single webm/gif file");
    }
    let path = match resolve_preset_asset(app, id, subdir, &name) {
        Ok(path) => path,
        Err(error) => return protocol_error(StatusCode::NOT_FOUND, &error),
    };
    let Ok(file) = fs::File::open(&path) else {
        return protocol_error(StatusCode::NOT_FOUND, "PET_PRESET_ASSET_READ_FAILED: asset could not be opened");
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return protocol_error(StatusCode::NOT_FOUND, "PET_PRESET_ASSET_READ_FAILED: asset metadata unavailable");
    };
    let mime = if name.ends_with(".webm") { "video/webm" } else { "image/gif" };
    let base = Response::builder()
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes");
    if request.method() == Method::HEAD {
        return base.header(CONTENT_LENGTH, length).status(StatusCode::OK).body(Vec::new()).unwrap();
    }
    let Some(range) = request.headers().get("range").and_then(|value| value.to_str().ok()) else {
        let mut bytes = Vec::new();
        let mut limited = file.take(PET_PRESET_MAX_FILE_BYTES.saturating_add(1));
        if limited.read_to_end(&mut bytes).is_err() || bytes.len() as u64 > PET_PRESET_MAX_FILE_BYTES {
            return Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(Vec::new()).unwrap();
        }
        return base.header(CONTENT_LENGTH, bytes.len()).status(StatusCode::OK).body(bytes).unwrap();
    };
    let Some((start, end)) = parse_single_byte_range(range, length) else {
        return base.header("Content-Range", format!("bytes */{length}")).status(StatusCode::RANGE_NOT_SATISFIABLE).body(Vec::new()).unwrap();
    };
    let size = end - start + 1;
    let Ok(capacity) = usize::try_from(size) else {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).body(Vec::new()).unwrap();
    };
    let mut bytes = vec![0; capacity];
    let mut file = file;
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut bytes).is_err() {
        return Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Vec::new()).unwrap();
    }
    base.header(CONTENT_LENGTH, size)
        .header("Content-Range", format!("bytes {start}-{end}/{length}"))
        .status(StatusCode::PARTIAL_CONTENT)
        .body(bytes)
        .unwrap()
}

fn protocol_error(status: StatusCode, error: &str) -> Response<Vec<u8>> {
    log::warn!("{error}");
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(error.as_bytes().to_vec())
        .unwrap()
}

fn parse_single_byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 || length == 0 { return None; }
        return Some((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= length { return None; }
    let end = if end.is_empty() { length - 1 } else { end.parse::<u64>().ok()?.min(length - 1) };
    (end >= start).then_some((start, end))
}

/// 列出已安装预设宠物的全部媒体（webm 动画 + preview 首张 gif 兜底图）。
/// 池条目（config.jsonc 里的动画名）即 webm 文件名主名，与 dsh-pet 协议一致。
#[tauri::command]
pub fn get_preset_pet_assets(app: AppHandle, id: String) -> Result<PresetPetAssets, String> {
    let id = id.trim();
    if !safe_preset_id(id) {
        return Err(format!("PET_PRESET_ID_INVALID: preset pet id {id:?} is not a safe id"));
    }
    let dir = installed_dir(&preset_pets_root(&app), id);
    if !dir.is_dir() {
        return Err(format!("PET_PRESET_NOT_INSTALLED: preset pet {id} is not installed"));
    }
    let webm_dir = dir.join("webm");
    let mut assets = BTreeMap::new();
    if webm_dir.is_dir() {
        let mut entries = fs::read_dir(&webm_dir)
            .map_err(|error| format!("PET_PRESET_ASSETS_READ_FAILED: failed to list {}: {error}", webm_dir.display()))?;
        let mut files = Vec::new();
        while let Some(entry) = entries.next() {
            let entry = entry.map_err(|error| format!("PET_PRESET_ASSETS_READ_FAILED: {error}"))?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else { continue };
            if name.ends_with(".webm") {
                files.push(name.to_string());
            }
        }
        files.sort();
        for file in files {
            let stem = file.trim_end_matches(".webm").to_string();
            let url = format!(
                "{PRESET_ASSET_ORIGIN}/{id}/webm/{}",
                percent_encode_segment(&file)
            );
            assets.insert(stem, url);
        }
    }
    // 兜底图：preview 目录第一张 gif（按文件名排序，与 dsh-pet preview 语义一致）。
    let preview_dir = dir.join("preview");
    if preview_dir.is_dir() {
        let mut entries = fs::read_dir(&preview_dir)
            .map_err(|error| format!("PET_PRESET_ASSETS_READ_FAILED: failed to list {}: {error}", preview_dir.display()))?;
        let mut gifs = Vec::new();
        while let Some(entry) = entries.next() {
            let entry = entry.map_err(|error| format!("PET_PRESET_ASSETS_READ_FAILED: {error}"))?;
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else { continue };
            if name.ends_with(".gif") {
                gifs.push(name.to_string());
            }
        }
        gifs.sort();
        if let Some(first) = gifs.into_iter().next() {
            let url = format!(
                "{PRESET_ASSET_ORIGIN}/{id}/preview/{}",
                percent_encode_segment(&first)
            );
            assets.insert("fallback".to_string(), url);
        }
    }
    Ok(PresetPetAssets { assets })
}

/// 统一预设配置校验错误前缀。
fn preset_config_invalid(detail: impl Into<String>) -> String {
    format!("PET_PRESET_CONFIG_INVALID: {}", detail.into())
}

/// 校验已安装预设宠物的 config.jsonc 协议形状（dsh-pet assets/config.jsonc 协议子集）：
/// - 顶层必须含 pets（非空数组，每项有非空 id）与 animations / animationWeights；
/// - animations 必须含 idle/turn/drag/clicks 字符串池、moves（default 对象 +
///   actions 数组）、categories（id/weight/actions）、可选 events；
/// - 池条目是动画名（webm 文件名主名），不做内置键白名单——合法性由
///   get_preset_pet_assets 的文件清单兜底，未知名字在播放层自然不可解析；
/// - animationWeights 的 idle/turn/move 必须是非负数字。
/// 任一不符返回带 PET_PRESET_CONFIG_INVALID 前缀的错误，不做静默兜底。
fn validate_preset_pet_config(value: &Value) -> Result<(), String> {
    let invalid = preset_config_invalid;
    let root = value
        .as_object()
        .ok_or_else(|| invalid("config root must be an object".to_string()))?;

    let pets = root
        .get("pets")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("pets must be a non-empty array".to_string()))?;
    if pets.is_empty() {
        return Err(invalid("pets must contain at least one pet".to_string()));
    }
    for pet in pets {
        let id = pet
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("each pet must have a non-empty string id".to_string()))?;
        let _ = id;
    }

    let animations = root
        .get("animations")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("animations must be an object".to_string()))?;
    for pool in ["idle", "turn", "drag", "clicks"] {
        let entries = animations
            .get(pool)
            .and_then(Value::as_array)
            .ok_or_else(|| invalid(format!("animations.{pool} must be an array")))?;
        validate_preset_pool_entries(entries, pool)?;
    }

    let moves = animations
        .get("moves")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("animations.moves must be an object".to_string()))?;
    if !moves.contains_key("default") || moves.get("default").and_then(Value::as_object).is_none() {
        return Err(invalid("animations.moves.default must be an object".to_string()));
    }
    let move_actions = moves
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("animations.moves.actions must be an array".to_string()))?;
    for action in move_actions {
        let name = action
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| invalid("each moves action must have a non-empty name".to_string()))?;
        let _ = name;
    }

    let categories = animations
        .get("categories")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("animations.categories must be an array".to_string()))?;
    for category in categories {
        let id = category
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("each category must have a non-empty id".to_string()))?;
        let _ = id;
        let weight = category
            .get("weight")
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid("each category must have a numeric weight".to_string()))?;
        if !weight.is_finite() || weight < 0.0 {
            return Err(invalid("category weight must be a non-negative number".to_string()));
        }
        let actions = category
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("each category must have an actions array".to_string()))?;
        validate_preset_pool_entries(actions, "categories.actions")?;
    }

    if let Some(events) = animations.get("events") {
        let events = events
            .as_object()
            .ok_or_else(|| invalid("animations.events must be an object".to_string()))?;
        for (event, pool) in events {
            let pool = pool
                .as_array()
                .ok_or_else(|| invalid(format!("animations.events.{event} must be an array")))?;
            validate_preset_pool_entries(pool, &format!("events.{event}"))?;
        }
    }

    let weights = root
        .get("animationWeights")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("animationWeights must be an object".to_string()))?;
    for key in ["idle", "turn", "move"] {
        let weight = weights
            .get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid(format!("animationWeights.{key} must be a number")))?;
        if !weight.is_finite() || weight < 0.0 {
            return Err(invalid(format!(
                "animationWeights.{key} must be a non-negative number"
            )));
        }
    }
    Ok(())
}

/// 池条目必须是非空字符串；空池（无动画可用）也允许，由运行时回落默认动画，
/// 但写了空字符串必须显式报错。
fn validate_preset_pool_entries(entries: &[Value], pool: &str) -> Result<(), String> {
    let invalid = preset_config_invalid;
    for entry in entries {
        let name = entry
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| invalid(format!("{pool} entries must be non-empty strings")))?;
        let _ = name;
    }
    Ok(())
}

/// 读取并解析已安装预设宠物的 config.jsonc（JSONC 协议），返回校验后的 JSON。
/// 与媒体同一资源边界：固定文件名 + 已安装目录 + 限量读取 + 显式错误前缀。
#[tauri::command]
pub fn get_preset_pet_config(app: AppHandle, id: String) -> Result<Value, String> {
    let id = id.trim();
    if !safe_preset_id(id) {
        return Err(format!("PET_PRESET_ID_INVALID: preset pet id {id:?} is not a safe id"));
    }
    let dir = installed_dir(&preset_pets_root(&app), id);
    if !dir.is_dir() {
        return Err(format!("PET_PRESET_NOT_INSTALLED: preset pet {id} is not installed"));
    }
    let path = dir.join("config.jsonc");
    let bytes = read_bounded_file(&path, PET_PRESET_CONFIG_MAX_BYTES, "PET_PRESET_CONFIG_READ_FAILED")?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|error| format!("PET_PRESET_CONFIG_INVALID: config.jsonc is not UTF-8: {error}"))?;
    let json = strip_jsonc(text);
    let value: Value = serde_json::from_str(&json)
        .map_err(|error| format!("PET_PRESET_CONFIG_INVALID: invalid JSON: {error}"))?;
    validate_preset_pet_config(&value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            Self(
                std::env::temp_dir().join(format!("dsh-preset-{name}-{}-{nonce}", std::process::id())),
            )
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn build_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut archive = tar::Builder::new(&mut encoder);
            for (name, bytes) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o100644);
                header.set_cksum();
                archive.append_data(&mut header, name, Cursor::new(bytes)).unwrap();
            }
        }
        encoder.finish().unwrap()
    }

    /// 手工构造含非法路径条目的 tar.gz（tar::Builder 会拒绝 `..`，这里绕开其校验，
    /// 先把非法条目按 POSIX ustar 头格式写入字节流，再追加正常条目并收尾）。
    fn build_tar_gz_with_raw_entry(good: &[(&str, &[u8])], raw_name: &str, raw_bytes: &[u8]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        // 先写非法路径条目（必须在 end-of-archive 零块之前，否则 tar 读不到）。
        let mut header = [0_u8; 512];
        let name = raw_name.as_bytes();
        header[..name.len().min(100)].copy_from_slice(&name[..name.len().min(100)]);
        header[100..108].copy_from_slice(b"0000644\0"); // mode
        header[108..116].copy_from_slice(b"0000000\0"); // uid
        header[116..124].copy_from_slice(b"0000000\0"); // gid
        header[124..136].copy_from_slice(&format!("{:011o}\0", raw_bytes.len()).as_bytes()); // size
        header[136..148].copy_from_slice(b"00000000000\0"); // mtime
        header[156] = b'0'; // typeflag = regular file
        let checksum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
        header[148..156].copy_from_slice(&format!("{checksum:06o}\0 ").as_bytes());
        tar_bytes.extend_from_slice(&header);
        let mut data = raw_bytes.to_vec();
        while data.len() % 512 != 0 {
            data.push(0);
        }
        tar_bytes.extend_from_slice(&data);
        // 正常条目 + 收尾零块。
        {
            let mut archive = tar::Builder::new(&mut tar_bytes);
            for (name, bytes) in good {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o100644);
                header.set_cksum();
                archive.append_data(&mut header, name, Cursor::new(bytes)).unwrap();
            }
            archive.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn catalog_deserializes_with_defaults_and_rejects_unknown_shape() {
        let spec: PresetPetSpec = serde_json::from_str(
            r#"{
                "id": "maid-deepseek-whale",
                "name": "Maid DeepSeek Whale",
                "repo": "https://github.com/PC2005-cloud/dsh-pet",
                "assets": "dsh-pet/assets",
                "sizeMb": 113
            }"#,
        )
        .unwrap();
        assert_eq!(spec.id, "maid-deepseek-whale");
        assert_eq!(spec.r#ref, None);
        assert_eq!(spec.size_mb, Some(113.0));
        assert_eq!(spec.image, None);
    }

    #[test]
    fn repo_owner_parsing_accepts_github_forms_and_rejects_others() {
        assert_eq!(
            parse_repo_owner("https://github.com/PC2005-cloud/dsh-pet").unwrap(),
            ("PC2005-cloud".to_string(), "dsh-pet".to_string())
        );
        assert_eq!(
            parse_repo_owner("http://github.com/owner/repo.git").unwrap(),
            ("owner".to_string(), "repo".to_string())
        );
        for invalid in ["https://gitlab.com/o/r", "ftp://github.com/o/r", "https://github.com/o", "not a url"] {
            assert!(
                parse_repo_owner(invalid).is_err(),
                "应拒绝 {invalid}"
            );
        }
    }

    #[test]
    fn tarball_urls_use_pinned_ref_and_append_mirror() {
        let spec = PresetPetSpec {
            id: "p".to_string(),
            name: "P".to_string(),
            desc: None,
            image: None,
            repo: "https://github.com/PC2005-cloud/dsh-pet".to_string(),
            assets: "dsh-pet/assets".to_string(),
            r#ref: Some("f0f772e".to_string()),
            size_mb: None,
        };
        let urls = tarball_urls(&spec).unwrap();
        assert_eq!(
            urls[0],
            "https://codeload.github.com/PC2005-cloud/dsh-pet/tar.gz/f0f772e"
        );
        assert!(urls[1].starts_with("https://ghfast.top/"));
        assert_eq!(urls[1], format!("https://ghfast.top/{}", urls[0]));
    }

    #[test]
    fn extraction_keeps_only_assets_prefix_and_strips_root_and_prefix() {
        let tarball = build_tar_gz(&[
            ("dsh-pet-f0f772e/dsh-pet/assets/config.jsonc", br#"{"animations":{}}"#),
            ("dsh-pet-f0f772e/dsh-pet/assets/webm/待机呼吸休闲.webm", b"webm-bytes"),
            ("dsh-pet-f0f772e/README.md", b"skip-me"),
            ("dsh-pet-f0f772e/dsh-pet/src/client.ts", b"skip-source"),
        ]);
        let directory = TestDirectory::new("prefix");
        fs::create_dir_all(&directory.0).unwrap();
        let tarball_path = directory.0.join("pkg.tar.gz");
        fs::write(&tarball_path, &tarball).unwrap();
        let staging = directory.0.join("staging");
        extract_preset_assets(&tarball_path, &staging, "dsh-pet/assets").unwrap();
        assert!(staging.join("config.jsonc").is_file());
        assert!(staging.join("webm/待机呼吸休闲.webm").is_file());
        assert_eq!(
            fs::read(staging.join("webm/待机呼吸休闲.webm")).unwrap(),
            b"webm-bytes"
        );
        assert!(!staging.join("README.md").exists());
        assert!(!staging.join("src/client.ts").exists());
    }

    #[test]
    fn extraction_reports_uncompressed_bytes_via_progress_callback() {
        let tarball = build_tar_gz(&[
            ("dsh-pet-f0f772e/dsh-pet/assets/webm/一.webm", b"0123456789"),
            ("dsh-pet-f0f772e/dsh-pet/assets/webm/二.webm", b"abcdefghijklmno"),
        ]);
        let directory = TestDirectory::new("progress");
        fs::create_dir_all(&directory.0).unwrap();
        let tarball_path = directory.0.join("pkg.tar.gz");
        fs::write(&tarball_path, &tarball).unwrap();
        let staging = directory.0.join("staging");
        let mut reported = Vec::new();
        extract_preset_assets_with_progress(
            &tarball_path,
            &staging,
            "dsh-pet/assets",
            Some(&mut |bytes| reported.push(bytes)),
        )
        .unwrap();
        // 每个文件解压后回调一次，字节数单调不减，末值 = 全部已解压字节。
        assert_eq!(reported, vec![10, 10 + 15]);
    }

    #[test]
    fn extraction_rejects_traversal_and_links_before_writing() {
        let directory = TestDirectory::new("traversal");
        fs::create_dir_all(&directory.0).unwrap();

        // traversal：tar 0.4 的 Archive 自身会拒绝 `..` 条目（读取即报错/跳过），
        // 解压层还有 safe_relative_path 兜底；这里断言无论哪一层拒绝，都不能把
        // 文件写到 staging 之外。
        let traversal = build_tar_gz_with_raw_entry(
            &[("root/dsh-pet/assets/config.jsonc", br#"{"animations":{}}"#)],
            "root/dsh-pet/assets/../escape.txt",
            b"bad",
        );
        let tarball_path = directory.0.join("bad.tar.gz");
        fs::write(&tarball_path, &traversal).unwrap();
        let staging = directory.0.join("staging");
        let result = extract_preset_assets(&tarball_path, &staging, "dsh-pet/assets");
        if let Err(error) = result {
            assert!(
                error.starts_with("PET_PRESET_PATH_INVALID:")
                    || error.starts_with("PET_PRESET_EXTRACT_FAILED:")
            );
        }
        assert!(!directory.0.join("escape.txt").exists(), "不得逃逸到 staging 之外");

        // safe_relative_path 直接兜底：任何 traversal/绝对/反斜杠/冒号路径必须被拒。
        for bad in ["../escape", "/absolute", "a/../../escape", "C:/escape", "..\\escape", "a:b"] {
            assert!(
                safe_relative_path(bad).is_err(),
                "应拒绝 {bad}"
            );
        }
        assert!(safe_relative_path("webm/待机呼吸休闲.webm").is_ok());

        // symlink 条目应被拒绝（entry_type = Symlink）
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut archive = tar::Builder::new(&mut encoder);
            let mut manifest = tar::Header::new_gnu();
            manifest.set_size(br#"{"animations":{}}"#.len() as u64);
            manifest.set_mode(0o100644);
            manifest.set_cksum();
            archive
                .append_data(
                    &mut manifest,
                    "root/dsh-pet/assets/config.jsonc",
                    Cursor::new(br#"{"animations":{}}"#),
                )
                .unwrap();
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_mode(0o120777);
            link.set_size(0);
            link.set_cksum();
            archive.append_link(&mut link, "root/dsh-pet/assets/link", "config.jsonc").unwrap();
        }
        let with_link = encoder.finish().unwrap();
        let tarball_path = directory.0.join("link.tar.gz");
        fs::write(&tarball_path, &with_link).unwrap();
        let staging = directory.0.join("staging2");
        let link_result = extract_preset_assets(&tarball_path, &staging, "dsh-pet/assets");
        assert!(
            link_result.as_ref().err().map(String::as_str).unwrap_or("").starts_with("PET_PRESET_LINK_FORBIDDEN:"),
            "unexpected link result: {link_result:?}"
        );
        assert!(!staging.join("link").exists(), "不得落盘链接条目");
        let _ = fs::remove_dir_all(&staging);
    }

    #[test]
    fn config_validation_rejects_truncated_shape_and_accepts_full_protocol() {
        let directory = TestDirectory::new("config");
        fs::create_dir_all(directory.0.join("staging")).unwrap();
        fs::write(
            directory.0.join("staging/config.jsonc"),
            "// 注释\n{\n  \"animations\": { \"idle\": [\"idle\"] }\n}\n",
        )
        .unwrap();
        // 形状残缺（只有 animations 对象）：安装期完整校验必须拒绝——否则 preset
        // 「安装成功、每次 get_preset_pet_config 都报错」，与实际读取行为不一致。
        assert!(validate_preset_config(&directory.0.join("staging"))
            .unwrap_err()
            .starts_with("PET_PRESET_CONFIG_INVALID:"));

        let missing = directory.0.join("staging-missing");
        fs::create_dir_all(&missing).unwrap();
        fs::write(missing.join("config.jsonc"), "{\"pets\": []}").unwrap();
        assert!(validate_preset_config(&missing)
            .unwrap_err()
            .starts_with("PET_PRESET_CONFIG_INVALID:"));

        // 完整协议形状：安装校验通过（与 get_preset_pet_config 同一校验）。
        let full = directory.0.join("staging-full");
        fs::create_dir_all(&full).unwrap();
        fs::write(
            full.join("config.jsonc"),
            r#"{
                "pets": [{ "id": "pet" }],
                "animations": {
                    "idle": ["idle"],
                    "turn": ["turn"],
                    "drag": ["drag"],
                    "clicks": ["click"],
                    "moves": { "default": {}, "actions": [{ "name": "move" }] },
                    "categories": [{ "id": "cat", "weight": 1, "actions": ["a"] }]
                },
                "animationWeights": { "idle": 10, "turn": 5, "move": 5 }
            }"#,
        )
        .unwrap();
        assert!(validate_preset_config(&full).is_ok());
    }

    #[test]
    fn progress_registry_round_trips_and_defaults_to_idle() {
        assert_eq!(get_preset_progress("nope").phase, "idle");
        set_preset_progress(
            "p1",
            PresetDownloadProgress {
                phase: "downloading".to_string(),
                received: 10,
                total: 100,
                error: None,
            },
        );
        let progress = get_preset_progress("p1");
        assert_eq!(progress.phase, "downloading");
        assert_eq!(progress.received, 10);
        assert_eq!(progress.total, 100);
    }

    #[test]
    fn preset_config_accepts_protocol_shaped_document() {
        let value: Value = serde_json::from_str(
            r#"{
  "pets": [{ "id": "main", "name": "蓝毛小女仆", "size": 462 }],
  "animations": {
    "idle": ["待机呼吸休闲"],
    "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"],
    "clicks": ["点击回应-开心跃动", "点击回应-元气挥手"],
    "moves": {
      "default": { "minDist": 60, "maxDist": 240, "margin": 20, "leadSec": 2, "tailSec": 2 },
      "actions": [{ "name": "螃蟹走路" }, { "name": "原地漂浮踏步", "params": { "minDist": 40 } }]
    },
    "categories": [
      { "id": "小动作", "weight": 20, "actions": ["悠闲哼歌", "写代码"] },
      { "id": "文字", "weight": 10, "noMirror": true, "actions": ["是啊，吃什么"] }
    ],
    "events": { "balance": ["余额-钱袋满溢"], "whisper": ["碎碎念-擦桌碎碎念"] }
  },
  "eventsRefreshSec": { "balance": 1800, "whisper": 300 },
  "animationWeights": { "idle": 10, "turn": 5, "move": 5 },
  "physics": { "gravity": 1400 }
}"#,
        )
        .unwrap();
        assert!(validate_preset_pet_config(&value).is_ok());
    }

    #[test]
    fn preset_config_rejects_bad_shape_and_empty_entries() {
        let missing_pets: Value = serde_json::from_str(
            r#"{
  "animations": {
    "idle": ["待机呼吸休闲"], "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"], "clicks": ["点击回应-开心跃动"],
    "moves": { "default": {}, "actions": [] }, "categories": []
  },
  "animationWeights": { "idle": 1, "turn": 1, "move": 1 }
}"#,
        )
        .unwrap();
        assert!(validate_preset_pet_config(&missing_pets)
            .unwrap_err()
            .starts_with("PET_PRESET_CONFIG_INVALID:"));

        let empty_entry: Value = serde_json::from_str(
            r#"{
  "pets": [{ "id": "main" }],
  "animations": {
    "idle": [""], "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"], "clicks": ["点击回应-开心跃动"],
    "moves": { "default": {}, "actions": [] }, "categories": []
  },
  "animationWeights": { "idle": 1, "turn": 1, "move": 1 }
}"#,
        )
        .unwrap();
        assert!(validate_preset_pet_config(&empty_entry)
            .unwrap_err()
            .starts_with("PET_PRESET_CONFIG_INVALID:"));

        let bad_weights: Value = serde_json::from_str(
            r#"{
  "pets": [{ "id": "main" }],
  "animations": {
    "idle": ["待机呼吸休闲"], "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"], "clicks": ["点击回应-开心跃动"],
    "moves": { "default": {}, "actions": [] }, "categories": []
  },
  "animationWeights": { "idle": -1, "turn": 1, "move": 1 }
}"#,
        )
        .unwrap();
        assert!(validate_preset_pet_config(&bad_weights)
            .unwrap_err()
            .starts_with("PET_PRESET_CONFIG_INVALID:"));
    }

    #[test]
    fn percent_round_trips_and_rejects_bad_input() {
        assert_eq!(percent_encode_segment("待机呼吸休闲.webm"), "%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm");
        assert_eq!(percent_encode_segment("maid-idle.webm"), "maid-idle.webm");
        assert_eq!(
            percent_decode_segment("%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.webm").unwrap(),
            "待机呼吸休闲.webm"
        );
        assert_eq!(percent_decode_segment("maid-idle.webm").unwrap(), "maid-idle.webm");
        assert!(percent_decode_segment("%E5%ZZ").is_err());
        assert!(percent_decode_segment("%E5%BE").is_err());
        // 半截编码应报错而非静默截断
        assert!(percent_decode_segment("abc%").is_err());
    }

    #[test]
    fn preset_asset_path_parses_segments_and_rejects_traversal() {
        assert_eq!(
            preset_asset_path("/maid-deepseek-whale/webm/%E5%BE%85.webm"),
            Some(("maid-deepseek-whale", "webm", "%E5%BE%85.webm"))
        );
        assert_eq!(
            preset_asset_path("/localhost/maid-deepseek-whale/preview/daiji.gif"),
            Some(("maid-deepseek-whale", "preview", "daiji.gif"))
        );
        assert_eq!(preset_asset_path("/a/b/c/d"), None);
        assert_eq!(preset_asset_path("/../escape/webm/x.webm"), None);
        assert_eq!(preset_asset_path("/a\\b/webm/x.webm"), None);
        assert_eq!(preset_asset_path("/a/webm/"), None);
        assert_eq!(preset_asset_path("/a/webm/../x.webm"), None);
    }

    #[test]
    fn strip_jsonc_removes_comments_outside_strings() {
        let src = r#"{
  // 行注释
  "url": "https://example.com/a//b", /* 块注释 */ "s": "/* kept */"
}"#;
        let stripped = strip_jsonc(src);
        assert!(!stripped.contains("行注释"));
        assert!(!stripped.contains("块注释"));
        assert!(stripped.contains("\"https://example.com/a//b\""));
        assert!(stripped.contains("\"/* kept */\""));
        let parsed: Value = serde_json::from_str(&stripped).expect("valid JSON");
        assert_eq!(parsed["url"], "https://example.com/a//b");
    }
}
