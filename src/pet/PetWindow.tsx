import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { If } from 'react-if-lite'

/**
 * 桌宠窗口：订阅 `$DSH_HOME/pets/state.json`（文件桥），按宠物状态切换动画。
 *
 * 状态由主窗体前端把 dsh 会话事件归一化后写入（见 `bridge::pet::report_pet_activity`），
 * 这里以 ~500ms 轮询 `get_pet_state` 读取。为避免主窗体高频事件让宠物动画不停闪回，
 * 状态文件写入时就做了 per-session 幂等（见 `config::pet_state`）。
 *
 * 动画：仓库尚无宠物 spritesheet 资产，先用纯 CSS 的占位猫咪演示完整状态机
 * （idle/thinking/working/error/attention/sleeping）；未来接入 pet.json + spritesheet
 * 契约（codex-to-dsh-pet 的 atlas 解析）时替换渲染层即可，状态映射保持不动。
 */

type PetState
  = | 'idle'
    | 'thinking'
    | 'working'
    | 'error'
    | 'attention'
    | 'sleeping'

interface PetStateFile {
  state: PetState
  session_id: string | null
  updated_at_ms: number
}

/** 各宠物状态对应的提示符号：仅在工作/思考/出错/注意时展示气泡，其余保持低调。 */
const STATE_COPY: Record<PetState, string> = {
  idle: '',
  thinking: '💭',
  working: '🛠️',
  error: '⚠️',
  attention: '🔔',
  sleeping: '💤',
}

/** 轮询间隔（毫秒）；文件桥推荐 500ms 轮询，fs-watcher 可后续叠加。 */
const POLL_INTERVAL = 500
/** 未知状态在状态机里的回落。 */
const FALLBACK_STATE: PetState = 'idle'

function normalizeState(value: string | undefined): PetState {
  if (value && value in STATE_COPY)
    return value as PetState
  return FALLBACK_STATE
}

/** 读取状态文件；tolerate 文件缺失（未启用桌宠 / 尚未产生状态）。 */
async function fetchPetState(): Promise<PetStateFile> {
  try {
    return await invoke<PetStateFile>('get_pet_state')
  }
  catch {
    return { state: 'idle', session_id: null, updated_at_ms: 0 }
  }
}

/** 状态气泡：仅在工作/思考/出错/注意时显示对应符号，空闲/睡眠时不打扰。 */
function StateBubble({ state }: { state: PetState }) {
  const copy = STATE_COPY[state]
  return (
    <If cond={copy !== ''}>
      <div className="pet-bubble pet-bubble-enter">{copy}</div>
    </If>
  )
}

/**
 * 宠物主体。以 CSS 类驱动关键帧动画；不同状态给到不同表情/律动。
 * `data-tauri-drag-region` 让整个窗口可作为拖拽区移动。
 */
function PetBody({ state }: { state: PetState }) {
  const eyesClosed = state === 'sleeping' || state === 'error'
  const mouthOpen = state === 'attention' || state === 'error'
  return (
    <div className={`pet-cat pet-cat-${state}`}>
      {/* 耳朵 */}
      <div className="pet-ear pet-ear-left" />
      <div className="pet-ear pet-ear-right" />
      {/* 头部 */}
      <div className="pet-head">
        <div className={`pet-eye pet-eye-left ${eyesClosed ? 'pet-eye-closed' : ''}`} />
        <div className={`pet-eye pet-eye-right ${eyesClosed ? 'pet-eye-closed' : ''}`} />
        <div className={`pet-mouth ${mouthOpen ? 'pet-mouth-open' : ''}`} />
      </div>
      {/* 身体 + 尾巴 */}
      <div className="pet-body">
        <div className="pet-tail" />
      </div>
    </div>
  )
}

export function PetWindow() {
  const [file, setFile] = useState<PetStateFile>({ state: 'idle', session_id: null, updated_at_ms: 0 })
  const state = normalizeState(file.state)

  useEffect(() => {
    let alive = true
    async function tick() {
      if (!alive)
        return
      const next = await fetchPetState()
      if (alive)
        setFile(next)
    }
    // 立即读一次（避免启动瞬间白屏），随后按固定间隔轮询。
    void tick()
    const timer = setInterval(() => {
      void tick()
    }, POLL_INTERVAL)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="pet-root" data-tauri-drag-region>
      <StateBubble state={state} />
      <PetBody state={state} />
    </div>
  )
}
