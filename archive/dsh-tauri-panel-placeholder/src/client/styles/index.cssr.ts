import { cssr, styles } from 'dsh-tauri-ui/client'

const { bem: { b, e } } = cssr
const { primary, secondary } = styles

/** 占位面板内容：居中容器 + 次级文案。 */
export default b('placeholder', [
  e('center', {
    boxSizing: 'border-box',
    minHeight: '100%',
    color: primary,
    alignItems: 'center',
    justifyContent: 'center',
    display: 'flex',
  }),
  e('text', {
    fontSize: '15px',
    color: secondary,
    userSelect: 'none',
  }),
])
