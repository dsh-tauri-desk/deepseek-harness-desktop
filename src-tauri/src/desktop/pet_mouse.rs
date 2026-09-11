//! 桌宠全局鼠标位置流（点击穿透恢复）。
//!
//! 桌宠窗口默认整窗点击穿透（`set_ignore_cursor_events(true)`，Windows 上等效
//! `WS_EX_TRANSPARENT | WS_EX_LAYERED`，命中测试完全透明），穿透态下 WebView
//! 收不到任何鼠标事件（mouseenter/mousemove 均不触发），前端无法感知光标
//! 移回命中区来关闭穿透——这就是社区常说的「穿透后无法恢复交互」死锁
//! （tauri issue #6164：官方 forward 选项一直未实现）。
//!
//! 解决方案（参考 Xinyu-Li-123/tauri-clickthrough-demo 与
//! codecnmc/tauri2-transparent-through）：用系统级全局钩子在独立线程监听鼠标
//! 移动，把物理像素光标坐标限频通过 `device-mouse-move` 事件发给前端；前端用
//! 命中区（窗口尺寸固定百分比）判定光标是否落在可交互区域，据此翻转
//! `setIgnoreCursorEvents`，穿透态下同样能感知光标位置，死锁解除。
//!
//! 性能：事件频率取决于鼠标报告率（125Hz–1000Hz），这里做两级收敛——监听线程
//! 只把最新坐标写入共享槽（覆盖不积压，回调不阻塞钩子）；节流线程每 16ms
//! 读取一次，坐标有变化才 emit（鼠标静止时零事件）。
//!
//! 生命周期：鼠标流由前端 `start_pet_mouse_stream` 命令幂等启动，线程随进程
//! 常驻（监听 API 为阻塞式，无停止 API）；桌宠隐藏时前端不再检查命中，线程
//! 开销可忽略。
//!
//! # 平台差异
//!
//! - **macOS**：用 `core-graphics` 的 `CGEventTap` 直接监听 mouse 事件。**不能**
//!   使用 `rdev`，因为 rdev 0.5.3 的 macOS 后端在 `CGEvent` 回调里对**所有**
//!   `KeyPress` 事件无条件调 `TSMGetInputSourceProperty`（HIToolbox API，必须
//!   在 main queue 上调用），而 rdev 在自己的后台线程上跑 `CFRunLoopRun`，触发
//!   `_dispatch_assert_queue_fail` → SIGTRAP。按单独 Cmd / Option / Control 键
//!   会发出 `FlagsChanged` 事件并经 rdev 转为 `KeyPress`，导致 100% 崩溃（issue
//!   #397）。只订阅 mouse 事件彻底绕开 TSM 路径。
//! - **Windows / Linux**：用 `rdev::listen`（这两平台 rdev 不调 TSM，无此 bug）。

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

/// macOS CGEventTap 只订阅的鼠标事件类型。**显式排除** KeyDown / KeyUp /
/// FlagsChanged，彻底切断 rdev 0.5.3 触发 `TSMGetInputSourceProperty`
/// （HIToolbox，必须 main queue）导致的 `dispatch_assert_queue` SIGTRAP
/// 崩溃链（issue #397）。
#[cfg(target_os = "macos")]
const MACOS_MOUSE_EVENTS: &[core_graphics::event::CGEventType] = &[
    core_graphics::event::CGEventType::MouseMoved,
    core_graphics::event::CGEventType::LeftMouseDragged,
    core_graphics::event::CGEventType::RightMouseDragged,
    core_graphics::event::CGEventType::ScrollWheel,
    core_graphics::event::CGEventType::OtherMouseDragged,
];

/// 全局鼠标流的进程级状态：幂等启动标记 + 当前事件的接收窗口。
///
/// 接收窗口必须是**可变**的：收起桌宠会销毁窗口（issue #469），重新显示时创建的是
/// 新窗口（旧 handle 已失效，向它 emit 不会有任何效果）。若把 `start_pet_mouse_stream`
/// 收到的窗口句柄直接搬进节流线程，重建后的桌宠就再也收不到鼠标位置，穿透永远无法
/// 按命中区恢复——宠物会整窗吞掉输入。这里改由前端每次挂载时刷新共享句柄。
#[derive(Default)]
pub struct PetMouseStreamState {
    started: Arc<AtomicBool>,
    emitter: Arc<Mutex<Option<WebviewWindow>>>,
}

/// 物理像素的光标位置（CGEvent 坐标为虚拟屏幕全局坐标，副屏可含负值）。
#[derive(Serialize, Clone, Copy, PartialEq)]
struct MouseCursorPos {
    x: f64,
    y: f64,
}

/// 启动全局鼠标位置流（幂等：已启动时只刷新接收窗口，不重复起线程）。
///
/// 命令参数带 `WebviewWindow`，Tauri 保证在主线程执行；`bind_pet_mouse_emitter`
/// 只做一次短临界区的句柄替换，不阻塞事件循环。
#[tauri::command]
pub fn start_pet_mouse_stream(window: WebviewWindow, state: State<'_, PetMouseStreamState>) {
    bind_pet_mouse_emitter(&state.emitter, window.clone());
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    // 监听线程失败时复位标记，允许前端重试（如钩子安装被系统拒绝）。
    let started_on_error = state.started.clone();
    let latest: Arc<Mutex<Option<MouseCursorPos>>> = Arc::default();

    // 监听线程：只把最新坐标写入共享槽，不做任何 IO。
    let store = latest.clone();
    thread::spawn(move || {
        if let Err(error) = listen_mouse(store.clone()) {
            log::error!("[pet-mouse] mouse listen failed: {error:?}");
            started_on_error.store(false, Ordering::SeqCst);
        }
    });

    // 节流线程：16ms 轮询最新坐标，变化才 emit（鼠标静止零事件）；每轮重新读取
    // 接收窗口，保证窗口重建后事件仍然投递到桌宠。
    let emitter = state.emitter.clone();
    thread::spawn(move || {
        let mut last_sent: Option<MouseCursorPos> = None;
        loop {
            let current = latest.lock().expect("pet mouse store poisoned").take();
            if let Some(pos) = current {
                if last_sent != Some(pos) {
                    last_sent = Some(pos);
                    let target = emitter
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .clone();
                    if let Some(target) = target {
                        let _ = target.emit(PET_MOUSE_MOVE_EVENT, pos);
                    }
                }
            }
            thread::sleep(THROTTLE_INTERVAL);
        }
    });
}

/// 把鼠标事件接收窗口指向最新挂载的桌宠窗口（窗口重建后必须调用）。
fn bind_pet_mouse_emitter(slot: &Arc<Mutex<Option<WebviewWindow>>>, window: WebviewWindow) {
    let mut current = slot.lock().unwrap_or_else(|error| error.into_inner());
    *current = Some(window);
}

/// 平台分发：macOS 走 CGEventTap，其它平台走 rdev。
fn listen_mouse(store: Arc<Mutex<Option<MouseCursorPos>>>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        listen_mouse_macos(store)
    }
    #[cfg(not(target_os = "macos"))]
    {
        listen_mouse_rdev(store)
    }
}

/// rdev 监听（Windows / Linux）。
#[cfg(not(target_os = "macos"))]
fn listen_mouse_rdev(store: Arc<Mutex<Option<MouseCursorPos>>>) -> Result<(), String> {
    let callback = move |event: rdev::Event| {
        if let rdev::EventType::MouseMove { x, y } = event.event_type {
            *store.lock().expect("pet mouse store poisoned") = Some(MouseCursorPos { x, y });
        }
    };
    rdev::listen(callback).map_err(|e| format!("rdev::listen: {e:?}"))
}

/// macOS CGEventTap 监听 mouse 事件（绕过 rdev 的 keyboard/TSM 路径，issue #397）。
#[cfg(target_os = "macos")]
fn listen_mouse_macos(store: Arc<Mutex<Option<MouseCursorPos>>>) -> Result<(), String> {
    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CallbackResult, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType,
    };

    CGEventTap::with_enabled(
        CGEventTapLocation::HID,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        MACOS_MOUSE_EVENTS.to_vec(),
        move |_proxy, event_type, event| {
            // 所有 MACOS_MOUSE_EVENTS 中带位置语义的类型都要更新光标位置。
            // ScrollWheel 是滚轮 delta 没有位置，跳过。
            if matches!(
                event_type,
                CGEventType::MouseMoved
                    | CGEventType::LeftMouseDragged
                    | CGEventType::RightMouseDragged
                    | CGEventType::OtherMouseDragged
            ) {
                let point = event.location();
                *store.lock().expect("pet mouse store poisoned") = Some(MouseCursorPos {
                    x: point.x,
                    y: point.y,
                });
            }
            // ListenOnly 模式：返回值会被忽略；用 Keep 表达"原样放行"语义。
            CallbackResult::Keep
        },
        CFRunLoop::run_current,
    )
    .map_err(|()| "CGEventTap::with_enabled failed (accessibility permission denied or HID unavailable)".to_string())?;

    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use core_graphics::event::CGEventType;

    /// CGEventType 不实现 PartialEq，借助 `#[repr(u32)]` 转整数比较。
    fn mask_codes() -> Vec<u32> {
        MACOS_MOUSE_EVENTS.iter().map(|e| *e as u32).collect()
    }

    /// 防止有人将来误把 keyboard / FlagsChanged 加进 `MACOS_MOUSE_EVENTS`，
    /// 重新触发 rdev 触发的 `TSMGetInputSourceProperty` → `dispatch_assert_queue`
    /// SIGTRAP（issue #397）。
    #[test]
    fn macos_mouse_events_exclude_keyboard() {
        let codes = mask_codes();
        for forbidden in [
            CGEventType::KeyDown,
            CGEventType::KeyUp,
            CGEventType::FlagsChanged,
        ] {
            assert!(
                !codes.contains(&(forbidden as u32)),
                "MACOS_MOUSE_EVENTS must not include {forbidden:?} (issue #397)"
            );
        }
    }

    /// 确认 mouse 事件主路径（`MouseMoved`）仍然在 mask 里——只测排除容易漏删。
    #[test]
    fn macos_mouse_events_include_mouse_moved() {
        assert!(mask_codes().contains(&(CGEventType::MouseMoved as u32)));
    }
}
