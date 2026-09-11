import { cssr } from 'dsh-tauri-ui/client'

const { bem: { b, e, m }, c } = cssr

/**
 * 变更卡片（turn-changes-card.tsx）——按官方 deliverables 行的视觉重做：
 * 白底 + 弱描边 + 14px 圆角；左侧 40px 圆角图标块；标题 15px/600；
 * 副行是绿 `+N` / 红 `-M`；右侧「撤销 ↶」纯文本按钮与描边胶囊「审核」；
 * 多文件时下方是文件清单（路径 + 右对齐计数），超过三行折叠成
 * 「再显示 N 个文件」，底部带分隔线。
 *
 * 单文件卡片（`--single`）在 hover 时把计数行换成「查看更改 ↗」：
 * 与官方一致，且这是纯 CSS 的状态切换（不引入组件状态）。
 */
export default b('turnrewind', {
  margin: '2px 0 6px',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}, [
  e('card', {
    boxSizing: 'border-box',
    width: '100%',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.18))',
    borderRadius: '14px',
    background: 'var(--dsw-alias-bg-base, #fff)',
    overflow: 'hidden',
  },
  /*
    TODO(view-changes-hover): hover 显示「查看更改」暂时整体停用（需求方要求），
    卡片当前只显示 +xx -x。恢复时改成**整卡**作用域（`&:hover`），
    这样单文件与多文件的 __head 都能生效：

    [
      c('&:hover .dshp-turnrewind__counts', { display: 'none' }),
      c('&:hover .dshp-turnrewind__hint', { display: 'inline-flex' }),
    ],
  */
  ),
  e('head', {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
  }),
  e('icon', {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '9px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
  }),
  e('meta', {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
  }),
  e('title', {
    fontSize: '13px',
    lineHeight: '18px',
    fontWeight: '600',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /*
    TODO(open-file): 单文件标题作为打开入口（<button class="__title--link">）时恢复：

    [
      m('link', {
        display: 'block',
        maxWidth: '100%',
        padding: '0',
        border: 'none',
        background: 'transparent',
        font: 'inherit',
        textAlign: 'left',
        color: 'inherit',
      }, [c('&:hover', { color: 'var(--dsw-alias-brand-primary, #2f6feb)' })]),
    ],
  */
  ),
  /*
    「打开文件」已开放：单文件标题会被渲染成 `<button class="__title--link">`
    （多文件清单行同理，见 `e('file')`）。这里只做**按钮基座重置**，使按钮的视觉与
    多文件的纯文本标题**完全一致**——刻意**不加任何 hover 规则**（需求：只开放功能、
    不加 hover 样式）。恢复 hover 换行时的写法见 `e('card')` 里的 TODO(view-changes-hover)。

    注意：字号/字重/行高**故意不写**。`__title`（同一个元素上）已经给了 13px/600/18px，
    这里再写 `font-size: inherit` 之类反而会因为规则在后面而**覆盖掉**它们，
    按钮于是退回卡片根的 12px/常规字重——单文件与多文件标题就会看起来不一样。
    只需要 `font-family: inherit`：按钮不会继承字体族（其余排印属性由 `__title` 决定）。
  */
  e('title--link', {
    display: 'block',
    minWidth: '0',
    maxWidth: '100%',
    padding: '0',
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'left',
    color: 'inherit',
    cursor: 'pointer',
  }),
  e('sub', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    lineHeight: '18px',
    minWidth: 0,
  }),
  e('counts', { display: 'inline-flex' }),
  e('hint-text', {
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  e('hint', {
    display: 'none',
    alignItems: 'center',
    gap: '4px',
    fontSize: '13px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    whiteSpace: 'nowrap',
  }),
  e('spacer', { flex: '1', minWidth: '8px' }),
  e('badge', {
    flex: 'none',
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '17px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))',
  }),
  e('undo', {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '28px',
    padding: '0 8px',
    border: 'none',
    borderRadius: '999px',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
  }, [
    c('& svg', { marginTop: '1px' }),
    c('&:hover:not(:disabled)', { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))' }),
    c('&:disabled', { cursor: 'default', opacity: '0.45' }),
  ]),
  e('review', {
    flex: 'none',
    height: '28px',
    padding: '0 12px',
    border: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.28))',
    borderRadius: '999px',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06))' }),
  ]),
  e('files', {
    borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.18))',
  }),
  /*
    清单行同时服务两种渲染：具备打开能力时是 `<button>`，否则是 `<div>`。
    下面这几条是按钮基座重置（对 `<div>` 无副作用），视觉与原来的行完全一致；
    **刻意不加 hover 规则**——保留的 `&:hover` 背景高亮是上一轮视觉对齐时就有的，
    本次开放点击没有新增任何 hover 样式。
  */
  e('file', {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '7px 10px',
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    textAlign: 'left',
    color: 'inherit',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06))' }),
    // 本 turn 删除的文件整行弱化：它们已不在工作区里。
    m('deleted', { color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' }),
    // 只有可点的那一支才带 `--open`（按钮指针样式；不可点的那支渲染成 <div>）。
    m('open', { cursor: 'pointer' }),
  ]),
  e('file-path', {
    flex: '1',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  e('file-counts', { flex: 'none' }),
  e('more', {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    width: '100%',
    padding: '7px 10px',
    border: 'none',
    borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.18))',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '18px',
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
  }, [
    c('&:hover', { background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06))' }),
  ]),
  e('notice', {
    padding: '7px 10px',
    borderTop: '1px solid var(--dsw-alias-border-weak, rgba(127,127,127,0.18))',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
  }, [
    m('error', { color: 'var(--dsw-alias-state-error-primary, #d93025)' }),
    // 「不在撤销范围内」的提示是中性说明（不是错误），用弱化色与更小字号区分。
    m('skip', {
      fontSize: '11px',
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)))',
    }),
  ]),
  e('conflict-list', {
    margin: '4px 0 0',
    padding: '0 0 0 16px',
    maxHeight: '120px',
    overflowY: 'auto',
  }),
  e('conflict-item', {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
])
