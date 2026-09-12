import { cssr } from '../utils/cssr'

const { c } = cssr

/**
 * 全局样式（挂载于 `apply`：`mountStyle(globalStyle, 'dsh-tauri-ui-global-styles')`）。
 *
 * 其中「右侧面板开关簇」一节原先由桌面端注入脚本（Rust `IFRAME_STYLES_JS`）承担，
 * 现统一收敛到本插件：页面里「按 aria-label 隐藏左侧收起按钮」的规则会误伤右侧
 * 面板开关，这里只把面板开关簇恢复回来。`.nArs4W_toggleCluster` 是旧版 dsh 的生成
 * 类名，保留兼容（优先使用插件的稳定标记 `data-dsh-toggle-cluster`）。
 */
export default c([
  c('[data-slot="sidebar.right.tab.guide"]', [
    c('[class$="guide"]', {
      gap: '8px',
    }),
    c('[class$="entry"]', {
      border: 'none',
      padding: '8px 16px',
      gap: '12px',
      minHeight: 'auto',
      alignItems: 'start',
    }),
    c('[class$="entryIcon"]', {
      marginTop: '2px',
      width: '18px',
      height: '18px',
    }),
    c('[class$="entryTitle"]', {
      fontSize: '14px',

    }),
    c('[class$="entryDescription"]', {
      fontSize: '12px',
    }),
  ]),
  c('[data-dsh-toggle-cluster], .nArs4W_toggleCluster', {
    top: '6px !important',
    right: '6px !important',
    gap: '2px !important',
  }),
  c('[data-dsh-toggle-cluster] button[aria-label], .nArs4W_toggleCluster button[aria-label]', {
    display: 'flex !important',
    borderRadius: '8px !important',
    flexShrink: 0,
  }),
])
