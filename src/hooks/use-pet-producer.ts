import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { useStore } from 'valtio-define'
import { store } from '@/store'

/**
 * 桌宠状态生产者：把桌面壳可观测的 Harness 生命周期归一化为宠物状态，写入
 * 状态文件桥（`bridge::pet::report_pet_activity` → `$DSH_HOME/pets/state.json`）。
 *
 * 这是 dsh 会话事件映射的一个「粗略基线」：
 * - 服务启动/重启中 → working（宠物忙碌）
 * - 服务就绪（ready）→ idle（宠物待命）
 * - 启动失败/停止 → error（宠物提示异常）
 *
 * 精确的 session 级映射（UserPromptSubmit → thinking、Stop → attention、
 * SessionEnd → sleeping 等）需要 dsh 插件在 iframe 内把会话事件转发出来
 * （`postMessage` / IPC），属后续迭代（见 issue #308 状态机映射表）。
 */
export function usePetProducer() {
  const { status, serviceRunning, busyAction, startupPhase } = useStore(store.harness)

  useEffect(() => {
    // 桌宠未启用时不做任何写入（避免无意义的文件 IO）。
    void invoke<{ enabled: boolean }>('get_pet_status').then((pet) => {
      if (!pet.enabled)
        return
      let state = 'idle'
      if (busyAction === 'start' || busyAction === 'restart' || (serviceRunning && startupPhase === 'process-boot'))
        state = 'working'
      else if (status === 'error')
        state = 'error'
      void invoke('report_pet_activity', { state, sessionId: null }).catch((err) => {
        console.warn('[PetProducer] report failed:', err)
      })
    }).catch(() => {})
  }, [status, serviceRunning, busyAction, startupPhase])
}
