import type { ArchiveWorkspaceDialogProps } from './archive-panel.types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { locale } from '../locales'

/** 「归档工作区」二次确认框（由 register 的工作区补丁以 createRoot 挂载）。 */
export function ArchiveWorkspaceDialog(props: ArchiveWorkspaceDialogProps) {
  return (
    <Modal
      open
      onClose={props.onClose}
      title={locale.text('archiveWorkspaceTitle', { count: props.sessionIds.length })}
      description={locale.text('archiveWorkspaceDescription', { workspace: props.workspaceTitle })}
      closeLabel={locale.text('close')}
      footer={(
        <>
          <Button variant="ghost" onClick={props.onClose} style={{ marginRight: 6 }}>{locale.text('cancel')}</Button>
          <Button variant="outline" onClick={props.onConfirm}>{locale.text('archiveWorkspaceConfirm')}</Button>
        </>
      )}
    />
  )
}
