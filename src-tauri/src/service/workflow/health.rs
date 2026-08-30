//! 健康检查（通过 Rust 代理，避免 WebView CORS 问题）。

use std::sync::atomic::Ordering;

use crate::config;

use super::process::{has_owned_process, LAUNCH_GUARD};
use super::utils;

/// 读取 Harness 首页并解析本次启动实际声明的客户端模块。
async fn client_probe_endpoints(port: u16) -> Result<Vec<String>, String> {
    let client = utils::loopback_http_client(config::HEALTH_CHECK_TIMEOUT)
        .map_err(|e| format!("HARNESS_HEALTH_CLIENT_FAILED: {e}"))?;
    let root = format!("{}/", config::get_dsh_service_url(port));
    let response = client
        .get(root)
        .send()
        .await
        .map_err(|e| format!("HARNESS_BOOT_MANIFEST_REQUEST_FAILED: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "HARNESS_NOT_READY: boot page returned {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("HARNESS_BOOT_MANIFEST_READ_FAILED: {e}"))?;
    Ok(utils::client_urls_from_boot_html(port, &body)
        .unwrap_or_else(|| utils::health_probe_plugin_urls(port)))
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

fn all_client_modules_ready(ready: usize, total: usize) -> bool {
    total > 0 && ready == total
}

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
pub async fn proxy_health_check(port: u16) -> Result<String, String> {
    if !has_owned_process() {
        return Err(not_owned_probe_signal(LAUNCH_GUARD.load(Ordering::SeqCst)).to_string());
    }
    let client = utils::loopback_http_client(config::HEALTH_CHECK_TIMEOUT)
        .map_err(|e| format!("HARNESS_HEALTH_CLIENT_FAILED: {e}"))?;
    let endpoints = client_probe_endpoints(port).await?;
    let total = endpoints.len();
    let mut ready = 0usize;
    let mut failures = Vec::with_capacity(total);

    for endpoint in endpoints {
        match client.get(&endpoint).send().await {
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                if utils::looks_like_plugin_bundle(status.is_success(), &body) {
                    ready += 1;
                    continue;
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
    if all_client_modules_ready(ready, total) {
        return Ok(format!("healthy - {ready}/{total} client modules ready"));
    }
    Err(format!(
        "HARNESS_NOT_READY: Harness client modules are not ready ({ready}/{total} ready; {})",
        failures.join("; ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn readiness_requires_every_client_module() {
        assert!(!all_client_modules_ready(1, 2));
        assert!(all_client_modules_ready(2, 2));
        assert!(!all_client_modules_ready(0, 0));
    }
}
