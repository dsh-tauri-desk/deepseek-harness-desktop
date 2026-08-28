use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime, WebviewWindow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub title: String,
    pub detail: String,
    pub log: String,
    pub r#type: String,
    pub percentage: f64,
    // 子任务进度
    pub progress: f64,
}

pub struct ProgressTracker<'a, R: Runtime> {
    window: &'a WebviewWindow<R>,
    total_phases: usize,
    current_phase: usize,
    current_title: String,
    current_type: String,
    last_emit_time: Mutex<Option<Instant>>,
}

impl<'a, R: Runtime> ProgressTracker<'a, R> {
    pub fn new(window: &'a WebviewWindow<R>, task_count: usize) -> Self {
        Self {
            window,
            total_phases: task_count,
            current_phase: 0,
            current_title: String::from("准备中..."),
            current_type: String::from(""),
            last_emit_time: Mutex::new(None),
        }
    }

    /// 切换阶段，并设置大标题
    pub fn start_phase(&mut self, r#type: &str, title: &str) {
        self.current_title = title.to_string();
        self.current_type = r#type.to_string();
    }

    /// 完成一个阶段
    pub fn end_phase(&mut self) {
        if self.current_phase < self.total_phases {
            self.current_phase += 1;
        }
    }

    /// stage_pct: 当前子任务的进度 (0.0 - 100.0)
    /// detail: 用于显示的主要信息 (如 "已下载 xx MB / xx MB" 或 "已解压 30%")
    /// log: 用于在 log 窗口显示的文字 (如 "Download http://..." 或 "Extract xx/xx/xx")
    pub fn update(&self, stage_pct: f64, detail: String, log: String) {
        let now = Instant::now();
        // 中毒安全：若 install 过程中已有 panic 污染该锁，后续不应再次 panic
        // 导致整个桌面进程退出，这里忽略中毒状态继续读取旧值。
        let mut last_emit = self
            .last_emit_time
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // 节流处理：如果距离上次发送不足 50ms，则跳过
        if let Some(last_time) = *last_emit {
            if now.duration_since(last_time) < Duration::from_millis(50) {
                return;
            }
        }

        *last_emit = Some(now);

        let phase_weight = 100.0 / self.total_phases as f64;
        let global_pct =
            (self.current_phase as f64 * phase_weight) + (stage_pct * phase_weight / 100.0);

        let _ = self.window.emit(
            "install-progress",
            ProgressPayload {
                title: self.current_title.clone(),
                r#type: self.current_type.clone(),
                percentage: global_pct,
                progress: stage_pct,
                detail,
                log,
            },
        );
    }

    /// 跳过指定数量的阶段
    pub fn skip_phases(&mut self, count: usize) {
        self.current_phase = (self.current_phase + count).min(self.total_phases);
    }
}
