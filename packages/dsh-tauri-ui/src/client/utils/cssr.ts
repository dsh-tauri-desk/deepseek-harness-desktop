import { plugin as bem } from '@css-render/plugin-bem'
import { CssRender } from 'css-render'

const root = CssRender()
const plugin = bem({ blockPrefix: '.dshp-' })
root.use(plugin)

/**
 * workspace 统一 css-render 实例与 bem 助手。
 *
 * 消费方（本插件与所有内置插件）一律从 `dsh-tauri-ui/client` 获取：
 *   cssr.c(...)          普通选择器
 *   cssr.bem.b('block')   -> .dshp-block
 *   cssr.bem.e('elem')    -> __elem
 *   cssr.bem.m('mod')     -> --mod
 * 不各自 new CssRender()，保证同一实例与 `cssr.find()` 去重。
 */
export const cssr = Object.assign(root, {
  bem: {
    b: plugin.cB,
    e: plugin.cE,
    m: plugin.cM,
  },
})
