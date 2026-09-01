import type { ReactElement } from 'react'

/**
 * content.tsx — 自定义内容区（样板视图）：居中占位「自定义内容区」。
 *
 * 本插件只负责「内容」，**自包含**（不依赖任何 props/翻译）：
 *   - 会话区替换的机制（conversation 槽动态 shadow、点击侧栏别处自动退出）
 *     由 dsh-tauri-panel 宿主承担——条目 onClick 调 renderPanelContent
 *     （见 ../dsh-tauri-panel/PROTOCOL.md「会话区替换」）；
 *   - 宽度约束宿主已包列（.dshp-panelViewColumn：max-width
 *     var(--dsh-chat-content-width, 748px)、width 100%、margin 0 auto、满高），
 *     此处只做垂直居中占位。
 */
export function Content(): ReactElement {
  return (
    <div>
      <p>自定义内容区</p>
    </div>
  )
}

export default Content
