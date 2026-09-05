use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;

const DSH_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const DSH_MAX_BACKUPS: usize = 3;
static DSH_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn dsh_log_lock() -> &'static Mutex<()> {
    DSH_LOG_LOCK.get_or_init(|| Mutex::new(()))
}

/// 构造仅用于回环地址探测的 HTTP 客户端。
///
/// 生命周期探测访问的是本机 dsh，不能继承 `HTTP_PROXY` / `ALL_PROXY`：部分代理
/// 不尊重回环地址直连，或应用进程没有 `NO_PROXY`，会把健康检查转发到外部代理，
/// 造成端口已经监听但持续误报未就绪。
pub(super) fn loopback_http_client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
}

/// 旧版客户端插件 bundle 探测地址。
///
/// SPA `/` 在 webServer 绑定后立刻 200，此时连接桥与 Loader 图往往还没就绪；
/// WebView 若在这个窗口加载，会永久停在官方 boot 页 “Loading plugins…”。
/// 旧版没有可读取的启动图时，保留这两个稳定入口作为兼容兜底。
pub(super) fn health_probe_plugin_urls(port: u16) -> Vec<String> {
    vec![
        format!("http://127.0.0.1:{port}/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"),
        format!("http://127.0.0.1:{port}/plugins/@deepseek-ai/dsh-client-runtime/client.js"),
    ]
}

/// 从新版 Harness 首页的 `__DSH_BOOT__` 启动图提取客户端 bundle 地址。
///
/// alpha 版不再保证桌面端旧适配器中的功能包名称存在，首页注入的启动图才是
/// WebView 实际会加载的唯一模块清单。这里不猜测替代包名，而是复用该清单中的
/// `entries`，同时加入 HTML 中预加载的 modules/runtime 两个入口。
pub(super) fn client_urls_from_boot_html(port: u16, html: &str) -> Option<Vec<String>> {
    let marker = "globalThis[\"__DSH_BOOT__\"] = ";
    let start = html.find(marker)? + marker.len();
    let end = html[start..].find("</script>")? + start;
    let json = html[start..end].trim().trim_end_matches(';').trim();
    let boot: serde_json::Value = serde_json::from_str(json).ok()?;
    let entries = boot.get("entries")?.as_array()?;
    let mut paths = Vec::new();

    // 预加载脚本不一定重复出现在 entries 的 url 中（例如老的 boot 页面），因此
    // 两类地址都收集后去重；只接受同源相对的插件 client.js 路径。
    for script in html.split("<script").skip(1) {
        let Some(src_start) = script.find("src=\"") else {
            continue;
        };
        let rest = &script[src_start + 5..];
        let Some(src_end) = rest.find('\"') else {
            continue;
        };
        let src = decode_html_attribute(&rest[..src_end]);
        if is_client_bundle_path(&src) {
            paths.push(src);
        }
    }
    for entry in entries {
        let Some(url) = entry.get("url").and_then(|v| v.as_str()) else {
            continue;
        };
        let url = decode_html_attribute(url);
        if is_client_bundle_path(&url) {
            paths.push(url);
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return None;
    }
    Some(
        paths
            .into_iter()
            .map(|path| format!("http://127.0.0.1:{port}{path}"))
            .collect(),
    )
}

/// 还原 boot HTML 属性/JSON 中的有限命名实体。
///
/// alpha 核心的 combo URL 使用 `&rev=...`，HTML 注入后会变成 `&amp;rev=...`；
/// 解析前还原它，否则 reqwest 会把实体名当成真实查询参数的一部分。
fn decode_html_attribute(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn is_client_bundle_path(path: &str) -> bool {
    // alpha combo 路由合法地使用 `/plugins/??<package>/client.js&rev=...`：
    // 第一个 `?` 是路由约定，第二个是 combo payload 的起始标记，不能把它拼成
    // `/plugins/??` 再交给 URL 解析器时丢掉一个问号。
    path.starts_with("/plugins/") && path.contains("client.js") && !path.starts_with("//")
}

/// 判断健康检查响应是不是可用的插件 bundle。
///
/// 未知 `/plugins/...` 路径会被 SPA fallback 成 `index.html`（仍是 200），
/// 绝不能当成插件已就绪。
pub(super) fn looks_like_plugin_bundle(ok_status: bool, body: &str) -> bool {
    if !ok_status {
        return false;
    }
    let trimmed = body.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") {
        return false;
    }
    true
}

/// 检查 Harness 是否真正在运行（探测指定端口，随配置端口联动）
pub async fn is_dsh_running(port: u16) -> bool {
    let client = loopback_http_client(Duration::from_secs(2)).ok(); // 将 Result 转为 Option

    // 如果 client 创建失败，直接返回 false
    let client = match client {
        Some(c) => c,
        None => return false,
    };

    let url = format!("{}/", crate::config::get_dsh_service_url(port));

    // 发送请求并判断是否就绪
    let check_status = async {
        let resp = client.get(&url).send().await.ok()?;
        if resp.status() != reqwest::StatusCode::OK {
            return None;
        }
        Some(true)
    };

    check_status.await.unwrap_or(false)
}

/// 检查指定端口是否被占用（通过尝试连接来判断）
pub fn is_port_in_use(port: u16) -> bool {
    // 以实际绑定结果判断，能够识别“已绑定但尚未 listen”的占用状态。
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpListener::bind(addr).is_err()
}

/// 在独立线程中读取子进程的输出，同时写入日志文件。
///
/// stdout 还会解析 `dsh web: <URL>?token=...` 这一行（写入 [`super::url_slot`] 并
/// 通过 Tauri 事件 [`super::url_extract::URL_EVENT`] 推前端），让桌面 WebView
/// iframe 拿到 alpha 浏览器会话鉴权所需的 token URL；stderr 不解析（避免插件
/// 子进程输出误判）。
///
/// # 参数
/// - `generation`: 本次启动的 generation 代号（[`super::url_slot::bump_generation`]
///   的返回值）。旧进程的迟到写会被 [`super::url_slot::try_set`] 丢弃。
pub fn spawn_output_readers<R1, R2>(
    stdout: Option<R1>,
    stderr: Option<R2>,
    log_path: PathBuf,
    app_handle: &AppHandle,
    generation: u64,
) where
    R1: Read + Send + 'static,
    R2: Read + Send + 'static,
{
    if let Some(stdout) = stdout {
        let log_path = log_path.clone();
        let app_handle = app_handle.clone();
        thread::spawn(move || {
            drain_subprocess_output(BufReader::new(stdout), log_path, log::Level::Info, Some(&app_handle), generation);
        });
    }
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            drain_subprocess_output(BufReader::new(stderr), log_path, log::Level::Warn, None, generation);
        });
    }
}

/// 逐行读取子进程输出并写入日志。
///
/// 任何一行是非法 UTF-8 时**必须**用 lossy 替换继续读下去，不能中断：管道
/// 读端一旦被关闭，dsh 主进程下一次写 stderr 就会收到 EPIPE，Node 以退出码 1
/// 静默崩溃（插件子进程——python MCP 服务器等——在中文本地化 Windows 下按
/// ANSI 代码页输出 GBK 日志是常态），桌面端表现为 Harness 反复崩溃、WebView
/// 永久卡在 "Loading plugins"。同样的非法字节在日志里以 U+FFFD 呈现，不影响
/// 其余行的可读性。真正需要停手的只有 EOF 与管道自身的 I/O 错误。
fn drain_subprocess_output<R: Read + Send + 'static>(
    mut reader: BufReader<R>,
    log_path: PathBuf,
    level: log::Level,
    app_handle: Option<&AppHandle>,
    generation: u64,
) {
    let parse_url = app_handle.is_some() && matches!(level, log::Level::Info);
    loop {
        let mut bytes = Vec::new();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
                let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
                let line = String::from_utf8_lossy(bytes);
                if parse_url {
                    if let Some(url) = super::url_extract::extract(&line) {
                        super::url_extract::emit_url_changed(app_handle.unwrap(), &url, generation);
                    }
                }
                match level {
                    log::Level::Warn => log::warn!(target: "dsh", "{}", line),
                    _ => log::info!(target: "dsh", "{}", line),
                }
                append_log(&log_path, &line);
            }
            Err(e) => {
                log::error!("Failed to read dsh {}: {}", log_level_name(level), e);
                break;
            }
        }
    }
}

/// `log::Level` 的小写名称（内部日志用词与旧实现一致）。
fn log_level_name(level: log::Level) -> &'static str {
    match level {
        log::Level::Warn => "stderr",
        _ => "stdout",
    }
}

fn append_log(log_path: &PathBuf, line: &str) {
    // 与 `logger` 的 `desktop.log` / `desktop.frontdesk.log` 保持一致：5MiB × 3 轮转
    let _guard = dsh_log_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "{}", line);
        let _ = file.flush();
    }
    // 超阈值则按大小轮转（与启动次轮转 `rotate_service_log` 互补，避免单次运行无限增长）
    if let Ok(meta) = std::fs::metadata(log_path) {
        if meta.len() > DSH_MAX_LOG_BYTES {
            let _ = std::fs::remove_file(indexed_log_path(log_path, DSH_MAX_BACKUPS));
            for i in (1..DSH_MAX_BACKUPS).rev() {
                let from = indexed_log_path(log_path, i);
                let to = indexed_log_path(log_path, i + 1);
                if from.exists() {
                    let _ = std::fs::remove_file(&to);
                    let _ = std::fs::rename(&from, &to);
                }
            }
            if log_path.exists() {
                let _ = std::fs::rename(log_path, indexed_log_path(log_path, 1));
            }
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(log_path);
        }
    }
}

/// 轮转日志文件名：`dsh-web.log`（index 0）、`dsh-web.log.1`、`dsh-web.log.2`……
fn indexed_log_path(log_path: &PathBuf, index: usize) -> PathBuf {
    if index == 0 {
        return log_path.clone();
    }
    let mut name = log_path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}", index));
    log_path.with_file_name(name)
}

/// 每次启动服务前轮转日志，只保留最近 `keep` 次启动产生的日志文件。
///
/// 把当前 `dsh-web.log` 依次后退为 `.1`、`.2`……，超过保留上限的最老文件
/// 直接删除，再以空文件重新记录本次启动日志。这样磁盘上始终只保留最近
/// `keep` 次 dsh 启动的日志，避免单文件随多次启动无限增长。
pub fn rotate_service_log(log_path: &PathBuf, keep: usize) {
    if keep == 0 {
        let _ = std::fs::remove_file(log_path);
        return;
    }
    // 1) 删除超过保留上限的最老文件（它会被顶上来的文件覆盖且无处安放）
    let _ = std::fs::remove_file(&indexed_log_path(log_path, keep - 1));
    // 2) 从次老到次新依次后移，为本次启动腾出位置
    for i in (1..keep).rev() {
        let from = indexed_log_path(log_path, i);
        let to = indexed_log_path(log_path, i + 1);
        if from.exists() {
            let _ = std::fs::remove_file(&to);
            let _ = std::fs::rename(&from, &to);
        }
    }
    // 3) 当前日志后移为 `.1`，重新开始本次记录
    if log_path.exists() {
        let _ = std::fs::rename(log_path, indexed_log_path(log_path, 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &PathBuf, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// 回归：非法 UTF-8 行（中文 Windows 下 python 插件输出 GBK 的典型形态）
    /// 绝不能让读取器中断——旧实现 break 会关闭管道读端，dsh 下次写 stderr
    /// 收到 EPIPE 以退出码 1 崩溃，表现为 Harness 崩溃循环 + WebView 卡在
    /// "Loading plugins"。
    #[test]
    fn drain_keeps_reading_after_invalid_utf8_lines() {
        let dir = std::env::temp_dir().join(format!("dsh_drain_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("out.log");

        // "因为测试" 的 GBK 编码（与系统 ANSI 代码页 936 输出一致）
        let mut data = b"first line\n".to_vec();
        data.extend_from_slice(b"\xd2\xf2\xce\xaa\xb2\xe2\xca\xd4\n");
        data.extend_from_slice(b"second line\n");

        drain_subprocess_output(
            std::io::BufReader::new(std::io::Cursor::new(data)),
            log.clone(),
            log::Level::Warn,
            None,
            0,
        );

        let content = fs::read_to_string(&log).unwrap();
        assert!(
            content.contains("first line"),
            "first line must be logged, got: {content:?}"
        );
        assert!(
            content.contains("second line"),
            "reader must NOT stop at invalid UTF-8 (old code broke and closed the pipe); got: {content:?}"
        );
        // 非法字节以 U+FFFD 呈现，行内容不丢失
        assert!(content.contains('\u{FFFD}'));
        let _ = fs::remove_dir_all(&dir);
    }

    /// `log::Level` 与日志名称的映射。
    #[test]
    fn log_level_name_maps_streams() {
        assert_eq!(log_level_name(log::Level::Warn), "stderr");
        assert_eq!(log_level_name(log::Level::Info), "stdout");
        assert_eq!(log_level_name(log::Level::Debug), "stdout");
    }

    /// 行尾处理与旧 `lines()` 行为一致：\n 与 \r\n 均被剥离。
    #[test]
    fn drain_strips_line_endings() {
        let dir = std::env::temp_dir().join(format!("dsh_drain_crlf_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("out.log");

        drain_subprocess_output(
            std::io::BufReader::new(std::io::Cursor::new(b"a\r\nb\n".to_vec())),
            log.clone(),
            log::Level::Info,
            None,
            0,
        );

        let content = fs::read_to_string(&log).unwrap();
        assert_eq!(content, "a\nb\n");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 模拟连续 5 次启动，验证磁盘上始终只保留最近 `keep` 份日志，
    /// 且每次启动都会新建当前日志文件。
    #[test]
    fn rotate_keeps_only_last_three_starts() {
        let dir = std::env::temp_dir().join(format!("dsh_rotate_test_{}", std::process::id()));
        let log = dir.join("dsh-web.log");
        let _ = fs::remove_dir_all(&dir);

        for i in 0..5 {
            // 每次启动前，当前日志写入上一批内容后轮转（与 sponsor 流程一致）
            write(&log, &format!("start {i} content\n"));
            rotate_service_log(&log, 3);
            // 轮转后当前文件应为空（尚未写入本次内容）
            assert_eq!(fs::read_to_string(&log).unwrap_or_default(), "");
            // 只允许保留 .0/.1/.2 三份
            assert!(!dir.join("dsh-web.log.3").exists());
            assert!(!dir.join("dsh-web.log.4").exists());
        }

        // 最后一次循环后：当前为空、.1 = start 4、.2 = start 3
        assert_eq!(fs::read_to_string(&log).unwrap_or_default(), "");
        assert!(fs::read_to_string(&dir.join("dsh-web.log.1"))
            .unwrap()
            .contains("start 4"));
        assert!(fs::read_to_string(&dir.join("dsh-web.log.2"))
            .unwrap()
            .contains("start 3"));
        assert!(!dir.join("dsh-web.log.3").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn boot_html_uses_declared_client_graph() {
        let html = r#"<script src="/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=one"></script><script>globalThis["__DSH_BOOT__"] = {"rev":"graph","entries":[{"id":"@deepseek-ai/dsh-client-ui-layout","url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js?rev=two","rev":"two"}]}</script>"#;
        let urls = client_urls_from_boot_html(3099, html).expect("boot graph");
        assert_eq!(urls.len(), 2);
        assert!(urls
            .iter()
            .any(|url| url.contains("dsh-client-modules/client.js")));
        assert!(urls
            .iter()
            .any(|url| url.contains("dsh-client-ui-layout/client.js")));
        assert!(urls
            .iter()
            .all(|url| url.starts_with("http://127.0.0.1:3099/plugins/")));
    }

    #[test]
    fn boot_html_rejects_missing_or_external_graph_entries() {
        assert!(client_urls_from_boot_html(3099, "<html></html>").is_none());
        let html = r#"<script>globalThis[\"__DSH_BOOT__\"] = {\"entries\":[{\"url\":\"https://example.test/client.js\"}]}</script>"#;
        assert!(client_urls_from_boot_html(3099, html).is_none());
    }

    /// alpha combo bundle 的 script src 位于 HTML 属性时，`&rev=` 会编码为
    /// `&amp;rev=`；探测 URL 必须先还原实体，否则服务端收到错误资源地址并返回 404。
    #[test]
    fn boot_html_decodes_combo_bundle_attribute_url() {
        let html = r#"<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=cddf5581d5d5"></script><script>globalThis["__DSH_BOOT__"] = {"entries":[]}</script>"#;
        let urls = client_urls_from_boot_html(3081, html).expect("boot graph");
        assert_eq!(urls, vec!["http://127.0.0.1:3081/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=cddf5581d5d5"]);
    }

    #[test]
    fn health_probe_plugin_urls_target_client_bundles_not_spa_root() {
        let urls = health_probe_plugin_urls(3080);
        assert!(urls.iter().all(|u| u.contains("/plugins/")));
        assert!(urls
            .iter()
            .all(|u| !u.ends_with("3080/") && !u.ends_with("://127.0.0.1:3080")));
        assert!(urls
            .iter()
            .any(|u| u.contains("dsh-client-ui-layout/client.js")));
    }

    #[test]
    fn spa_html_fallback_is_not_a_plugin_bundle() {
        assert!(!looks_like_plugin_bundle(
            true,
            "<!doctype html><html lang=\"en\"><body>HARNESS Loading plugins...</body></html>"
        ));
        assert!(!looks_like_plugin_bundle(
            true,
            "<html><head></head></html>"
        ));
        assert!(!looks_like_plugin_bundle(true, "   "));
        assert!(!looks_like_plugin_bundle(
            false,
            "window.__ModuleLoader__={}"
        ));
        assert!(looks_like_plugin_bundle(
            true,
            "window.__ModuleLoader__.load({id:\"@deepseek-ai/dsh-client-ui-layout\"})"
        ));
    }

    /// keep=0 时把当前日志也删掉。
    #[test]
    fn rotate_with_keep_zero_removes_all() {
        let dir = std::env::temp_dir().join(format!("dsh_rotate_zero_{}", std::process::id()));
        let log = dir.join("dsh-web.log");
        let _ = fs::remove_dir_all(&dir);
        write(&log, "x");
        write(&dir.join("dsh-web.log.1"), "x");
        rotate_service_log(&log, 0);
        assert!(!log.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
