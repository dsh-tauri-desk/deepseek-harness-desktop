import { cssr, styles as sharedStyles } from 'dsh-tauri-ui/client'

const { bem: { b, e, m } } = cssr
const { secondary, tertiary } = sharedStyles

export default b('extension', [
  e('import-scroll', {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    maxHeight: 'min(400px,52vh)',
    overflowY: 'auto',
    padding: '2px 4px 2px 2px',
  }),
  e('import-group', { display: 'flex', flexDirection: 'column', gap: '8px' }),
  e('import-head', { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 2px' }),
  e('import-count', { fontSize: '12px', lineHeight: '18px', color: tertiary }),
  e('import-all', {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: secondary,
    cursor: 'pointer',
  }),
  e('import-choice', {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    minWidth: '0',
  }, [
    m('disabled', { cursor: 'default' }),
  ]),
])
