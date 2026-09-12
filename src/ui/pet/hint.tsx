import { IS_ZH } from '@/pet/utils/bubble'

/**
 * hint.tsx — 桌宠窗口里唯一会出现的文字提示。
 *
 * 桌宠窗口是透明置顶小窗，**没有任何其它 UI 或 i18n 基础设施**（气泡文案同样就地取
 * 单语），所以这里按窗口语言（`pet/utils/bubble` 的 `IS_ZH`，与气泡文案同源）就近给出
 * 单句提示。静默留空是不行的：用户看到的是「宠物加载不出来」，既不知道原因也不知道去哪修。
 */

export interface HintProps {
  /** 已选中的宠物 id（用于提示里点名，便于用户回设置页找到它）。 */
  petId: string
}

/** 选中的宠物解析不出资源时的可见提示（导入的宠物被删除、清单里没有这个 id 等）。 */
export function Hint(props: HintProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center select-none">
      <div className="max-w-[95%] rounded-lg bg-black/70 px-3 py-1.5 text-center text-xs leading-relaxed text-white">
        {IS_ZH
          ? `宠物「${props.petId}」的资源不可用，请在 设置 → 宠物 中重新选择`
          : `Pet “${props.petId}” is unavailable — pick another one in Settings → Pets`}
      </div>
    </div>
  )
}
