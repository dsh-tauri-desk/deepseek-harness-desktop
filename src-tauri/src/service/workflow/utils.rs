use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// 检查 Harness 是否真正在运行（探测指定端口，随配置端口联动）
pub async fn is_dsh_running(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok(); // 将 Result 转为 Option

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
/// `on_stdout_line` 用于接收 dsh 的启动就绪信号；它不参与日志写入，
/// 因此回调失败或缺失都不会影响输出转发。
pub fn spawn_output_readers<R1, R2>(
    stdout: Option<R1>,
    stderr: Option<R2>,
    log_path: PathBuf,
    on_stdout_line: Option<Arc<dyn Fn(&str) + Send + Sync>>,
)
where
    R1: Read + Send + 'static,
    R2: Read + Send + 'static,
{
    // 在独立线程中读取 stdout
    if let Some(stdout) = stdout {
        let log_path = log_path.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if let Some(on_stdout_line) = &on_stdout_line {
                            on_stdout_line(&line);
                        }
                        log::info!("[dsh::stdout]: {}", line);
                        append_log(&log_path, &line);
                    }
                    Err(e) => {
                        log::error!("Failed to read dsh stdout: {}", e);
                        break;
                    }
                }
            }
        });
    }

    // 在独立线程中读取 stderr
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::warn!("[dsh::stderr]: {}", line);
                        append_log(&log_path, &line);
                    }
                    Err(e) => {
                        log::error!("Failed to read dsh stderr: {}", e);
                        break;
                    }
                }
            }
        });
    }
}

fn append_log(log_path: &PathBuf, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "{}", line);
    }
}
