//! 桌宠全局鼠标位置流（点击穿透恢复）。
//!
//! 桌宠窗口默认整窗点击穿透（`set_ignore_cursor_events(true)`，Windows 上等效
//! `WS_EX_TRANSPARENT | WS_EX_LAYERED`，命中测试完全透明），穿透态下 WebView
//! 收不到任何鼠标事件（mouseenter/mousemove 均不触发），前端无法感知光标
//! 移回命中区来关闭穿透——这就是社区常说的「穿透后无法恢复交互」死锁
//! （tauri issue #6164：官方 forward 选项一直未实现）。
//!
//! 解决方案（参考 Xinyu-Li-123/tauri-clickthrough-demo 与
//! codecnmc/tauri2-transparent-through）：用 rdev 低级全局钩子（Windows
//! `WH_MOUSE_LL`）在独立线程监听系统级鼠标移动，把物理像素光标坐标限频
//! 通过 `device-mouse-move` 事件发给前端；前端用命中区（窗口尺寸固定百分比）
//! 判定光标是否落在可交互区域，据此翻转 `setIgnoreCursorEvents`，
//! 穿透态下同样能感知光标位置，死锁解除。
//!
//! 性能：rdev 事件频率取决于鼠标报告率（125Hz–1000Hz），这里做两级收敛——
//! 监听线程只把最新坐标写入共享槽（覆盖不积压，回调不阻塞钩子）；节流线程
//! 每 16ms 读取一次，坐标有变化才 emit（鼠标静止时零事件）。
//!
//! 生命周期：鼠标流由前端 `start_pet_mouse_stream` 命令幂等启动，线程随进程
//! 常驻（rdev::listen 为阻塞式，无停止 API）；桌宠隐藏时前端不再检查命中，
//! 线程开销可忽略。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, State, WebviewWindow};

/// 全局鼠标事件名（与前端 `@tauri-apps/api/event` 的 listen 保持一致）。
pub const PET_MOUSE_MOVE_EVENT: &str = "device-mouse-move";
/// 节流间隔（16ms ≈ 60FPS）：光标自身刷新率远超此频率，超出部分无意义。
const THROTTLE_INTERVAL: Duration = Duration::from_millis(16);

/// 全局鼠标流的进程级状态（幂等启动标记）。
#[derive(Default)]
pub struct PetMouseStreamState {
    started: Arc<AtomicBool>,
}

/// 物理像素的光标位置（rdev 坐标为虚拟屏幕全局坐标，副屏可含负值）。
#[derive(Serialize, Clone, Copy, PartialEq)]
struct MouseCursorPos {
    x: f64,
    y: f64,
}

/// 启动全局鼠标位置流（幂等：已启动时直接返回）。
#[tauri::command]
pub fn start_pet_mouse_stream(window: WebviewWindow, state: State<'_, PetMouseStreamState>) {
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    // 监听线程失败时复位标记，允许前端重试（如钩子安装被系统拒绝）。
    let started_on_error = state.started.clone();
    let latest: Arc<Mutex<Option<MouseCursorPos>>> = Arc::default();

    // 监听线程：rdev::listen 为阻塞式，回调只写最新坐标，不做任何 IO。
    let store = latest.clone();
    thread::spawn(move || {
        let callback = move |event: rdev::Event| {
            if let rdev::EventType::MouseMove { x, y } = event.event_type {
                *store.lock().expect("pet mouse store poisoned") = Some(MouseCursorPos { x, y });
            }
        };
        if let Err(error) = rdev::listen(callback) {
            log::error!("[pet-mouse] rdev listen failed: {error:?}");
            started_on_error.store(false, Ordering::SeqCst);
        }
    });

    // 节流线程：16ms 轮询最新坐标，变化才 emit（鼠标静止零事件）。
    let emitter = window.clone();
    thread::spawn(move || {
        let mut last_sent: Option<MouseCursorPos> = None;
        loop {
            let current = latest.lock().expect("pet mouse store poisoned").take();
            if let Some(pos) = current {
                if last_sent != Some(pos) {
                    last_sent = Some(pos);
                    let _ = emitter.emit(PET_MOUSE_MOVE_EVENT, pos);
                }
            }
            thread::sleep(THROTTLE_INTERVAL);
        }
    });
}