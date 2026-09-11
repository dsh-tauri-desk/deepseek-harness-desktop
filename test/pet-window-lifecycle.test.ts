// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 桌宠窗口生命周期契约（issue #469）。
 *
 * 「收起宠物」必须是**销毁窗口**而不是 hide：隐藏只是把窗口从屏幕上撤下，WebView 与
 * 页面都还在，桌宠的 `<video>` 继续解码播放——Chromium/WebView2 对「播放中（未暂停）
 * 的 video」无条件持有 Video Wake Lock，屏幕永远无法息屏，且白占 CPU。这些用例把
 * 该语义锁在源码层面：Rust 侧一旦退回 `hide()` 或重新预创建隐藏窗口，测试即失败。
 */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

/** 截取指定函数体的源码（从 ` fn name` 起，到下一个顶层 `}` 后换行 + 空行为止）。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`pub fn ${name}`)
  expect(start, `expected to find fn ${name}`).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.indexOf('\n}\n')
  return end === -1 ? rest : rest.slice(0, end)
}

describe('pet window collapse (destroy, not hide)', () => {
  const petWindow = readSource('../src-tauri/src/desktop/pet.rs')

  it('destroys the pet webview window instead of hiding it', () => {
    const body = functionBody(petWindow, 'set_pet_window_visible')

    expect(body).toContain('.destroy()')
    expect(body).not.toContain('.hide()')
    // 隐藏分支必须先把已存在的窗口销毁，不能在窗口缺失时静默成功（那会留下
    // 「状态说已收起、窗口其实还在」的假象）。
    expect(body).toContain('PET_WINDOW_DESTROY_FAILED')
  })

  it('never creates a hidden pet window while the pet is disabled', () => {
    const body = functionBody(petWindow, 'init_pet_window')

    // 未启用直接返回，不建窗口：没人看的 webview 同样会加载 pet.html 播放动画。
    expect(body).toContain('pet_enabled')
    expect(body).not.toContain('ensure_pet_window')
    expect(body).not.toContain('.hide()')
  })
})

describe('pet window lifecycle never runs on the main thread', () => {
  const bridge = readSource('../src-tauri/src/bridge/pet.rs')

  it('defers every window visibility change off the command thread', () => {
    // command handler 在主线程执行，而 tauri-runtime-wry 在主线程上：
    // destroy 直接 panic（lib.rs:3494 "cannot handle WindowMessage::Destroy on the main
    // thread"）、create_window 经 channel 等事件循环回包而死锁。所以窗口操作必须
    // 经 defer_pet_window_op 丢到异步运行时。
    expect(bridge).toContain('fn defer_pet_window_op')
    expect(bridge).toContain('tauri::async_runtime::spawn')
    expect(bridge).toContain('let _guard = pet_window_op_lock()')

    for (const name of ['set_pet_enabled', 'show_pet', 'collapse_pet']) {
      const body = functionBody(bridge, name)
      expect(body, `${name} must defer the window op`).toContain('defer_pet_window_op')
      // 命令里不得直接触碰窗口生命周期 API（那正是超时/panic 的来源）。
      expect(body, `${name} must not call set_pet_window_visible directly`).not.toContain('set_pet_window_visible')
    }
  })

  it('serializes concurrent visibility operations with a lock', () => {
    // 快速连点收起/显示时两次 spawn 会并发；加锁保证最终态等于最后一次调用。
    expect(bridge).toContain('OnceLock<Mutex<()>>')
  })
})

describe('pet window collapse state sync', () => {
  const bridge = readSource('../src-tauri/src/bridge/pet.rs')

  it('collapses transient visibility and the host session stream together', () => {
    const body = functionBody(bridge, 'collapse_pet')

    // 销毁窗口之外还要落瞬态可见性与会话流，否则侧栏图标仍显示「已激活」、
    // 宿主侧还会持续为桌宠推送会话数据。
    expect(body).toContain('visible = false')
    expect(body).toContain('defer_pet_window_op(app, false)')
    expect(body).toContain('sync_pet_session_stream(app, false)')
  })

  it('routes the window close request through the same collapse path', () => {
    const builder = readSource('../src-tauri/src/desktop/builder.rs')

    expect(builder).toContain('collapse_pet(&handle)')
  })
})

describe('recreated pet window keeps its mouse stream', () => {
  const mouse = readSource('../src-tauri/src/desktop/pet_mouse.rs')

  it('rebinds the global mouse emitter to the window that just mounted', () => {
    // 窗口销毁重建后旧句柄失效：若节流线程一直握着旧窗口，重建后的桌宠收不到
    // 鼠标位置，点击穿透就再也无法按命中区恢复。
    expect(mouse).toContain('bind_pet_mouse_emitter')
    expect(mouse).toContain('state.emitter.clone()')
  })

  it('forces one cursor update after a rebind, even without cursor movement', () => {
    // 去重（last_sent）会跳过「光标没动」的发送：换窗口后若不强制补发一次，
    // 新页面收不到任何 device-mouse-move，穿透态停在整窗接收事件，透明区域吞点击。
    expect(mouse).toContain('revision.fetch_add')
    expect(mouse).toContain('rebound')
  })
})
