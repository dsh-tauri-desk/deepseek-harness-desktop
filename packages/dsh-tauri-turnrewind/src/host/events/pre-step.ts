import { TURNREWIND_PLUGIN_NAME } from '../../shared/constants'
import { capture } from '../service/capture'

/**
 * `agent/pre-step` 是唯一会 **await** 的钩子（执行屏障）：step === 1 时把 before 快照做在
 * 模型请求与工具执行之前。任何异常都吞掉后继续 `next()`——快照失败绝不能拦住用户的 turn。
 */
export async function handlePreStep(payload: any, next: () => Promise<any>): Promise<any> {
  try {
    const sessionId = payload?.agent?.session?.id
    if (payload?.step === 1 && typeof sessionId === 'string' && typeof payload?.turn === 'number')
      await capture.begin(sessionId, payload.turn)
  }
  catch (error) {
    console.warn(`${TURNREWIND_PLUGIN_NAME}: before snapshot failed: ${String(error)}`)
  }
  return next()
}
