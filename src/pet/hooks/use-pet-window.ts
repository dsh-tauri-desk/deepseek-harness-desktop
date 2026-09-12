import { useWatch } from '@reause/core'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { PET_BUBBLE_MIN_WIDTH, PET_WINDOW_PAD_X, PET_WINDOW_PAD_Y } from '../constants'

/**
 * 让桌宠窗口跟随宠物真实画布尺寸缩放（设置页大小滑条实时生效）。
 *
 * Rust 只按「预设 16:9 / 图集 208:192」的近似比例创建窗口；真实比例由渲染层决定
 * （Codex 图集的实际格子比例、清单里的 size 都可能不同），所以尺寸的统一出口在这里，
 * 避免两处 set_size 互相打架（issue #308）。加宽窗口只向左扩展透明区，宠物锚定
 * 右下角，屏幕位置保持不变。
 *
 * 尺寸/可见性变化即重算（`useWatch` + `immediate` 覆盖挂载首帧），无需卸载清理。
 *
 * @param width 宠物渲染宽度（px）
 * @param aspect 画布比例（高 / 宽）
 * @param visible 窗口当前是否可见；不可见时不折腾几何
 */
export function usePetWindowSize(width: number, aspect: number, visible: boolean): void {
  useWatch([width, aspect, visible], ([nextWidth, nextAspect, nextVisible]) => {
    if (!nextVisible)
      return
    const windowWidth = Math.max(nextWidth + PET_WINDOW_PAD_X, PET_BUBBLE_MIN_WIDTH)
    const windowHeight = nextWidth * nextAspect + PET_WINDOW_PAD_Y
    void getCurrentWindow()
      .setSize(new LogicalSize(windowWidth, windowHeight))
      .then(() => {
        // 放大后把窗口夹回可见显示器，避免右侧/底部被推出屏幕。
        void invoke<void>('move_pet_window', { deltaX: 0, deltaY: 0 }).catch(() => {})
      })
      .catch((error) => {
        console.warn('[pet] PET_WINDOW_RESIZE_FAILED:', error)
      })
  }, { immediate: true })
}
