import { useWatch } from '@hairy/react-lib'
import { useStore } from 'valtio-define'
import { useCoreBreakingConfirm } from '@/hooks/use-core-breaking-confirm'
import { store } from '@/store'

/** 右下角“发现新版本”提示条：状态与操作直接来自 updater store */
export function HarnessUpdater() {
  const { updateInfo, updating } = useStore(store.harnessUpdater)
  const { holder, confirmCoreBreaking } = useCoreBreakingConfirm()

  useWatch([updateInfo, updating], () => {
    if (!updateInfo || updating)
      return
    // 高于 rc.2 时先弹破坏性更改确认，取消则不提示更新（不进入下载）
    void showAfterConfirm(updateInfo.tag)
  }, { immediate: true })

  async function showAfterConfirm(tag: string) {
    if (!(await confirmCoreBreaking(tag)))
      return
    store.harnessUpdater.showToast()
  }

  return holder
}
