/**
 * constants.ts — 桌宠窗口的几何常量。
 *
 * 与 Rust 侧 `desktop::pet`（`PET_SPRITE_BASE_WIDTH` / `PET_WINDOW_PAD_X` /
 * `PET_WINDOW_TOP_PAD` / `PET_WINDOW_BOTTOM_PAD` / `PET_WINDOW_MIN_WIDTH`）保持
 * 一致：Rust 负责窗口创建与 DPI 变化时的初始尺寸，pet WebView 拿到真实画布比例后
 * 实时修正，两处必须同源，否则缩放时会来回打架（issue #308）。
 */

/** 宠物基准渲染宽度（px，100% 档位）。 */
export const PET_BASE_WIDTH = 220

/** 窗口右侧留白（逻辑像素）。 */
export const PET_WINDOW_PAD_X = 32

/** 顶部 Toast 区 + 底部留白（逻辑像素）。 */
export const PET_WINDOW_PAD_Y = 82

/** 顶栏 Toast 区的最小窗口宽度（逻辑像素）：桌宠较小时仍保证气泡可读。 */
export const PET_BUBBLE_MIN_WIDTH = 420

/** 宠物大小百分比缺省值与合法区间（与设置页滑条一致）。 */
export const PET_SIZE_DEFAULT_PERCENT = 100
export const PET_SIZE_MIN_PERCENT = 50
export const PET_SIZE_MAX_PERCENT = 200

/** dsh-pet 透明视频画布比例（高/宽 = 9/16）。 */
export const PET_DSH_ASPECT = 9 / 16

/** Codex 图集画布比例（8 列 × 11 行，格子 192×208）。 */
export const PET_CODEX_ASPECT = 208 / 192
