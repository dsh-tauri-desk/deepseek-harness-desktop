/** 缩放动作（与宿主 `src/utils/zoom.ts` 的 `ZoomAction` 同口径）。 */
export type ZoomAction = 'increase' | 'decrease' | 'reset'

/** 快捷键形态：只取判定所需字段，便于单测直接构造。 */
export interface ZoomShortcutLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * 缩放快捷键 → 动作：Ctrl/Cmd + `+` / `=` / `-` / `_` / `0`（Alt 组合不处理）。
 *
 * 与宿主 `src/utils/zoom.ts` 的 `zoomActionFromShortcut` 保持同一口径：两端都会收到
 * 快捷键（壳层自身按键 / iframe 内捕获后经父窗口桥转发），判定必须一致，否则同一组
 * 按键在两个焦点位置的行为不同。
 */
export function zoomActionFromShortcut(shortcut: ZoomShortcutLike): ZoomAction | null {
  if ((!shortcut.ctrlKey && !shortcut.metaKey) || shortcut.altKey)
    return null

  if (shortcut.key === '+' || shortcut.key === '=')
    return 'increase'
  if (shortcut.key === '-' || shortcut.key === '_')
    return 'decrease'
  if (shortcut.key === '0')
    return 'reset'
  return null
}
