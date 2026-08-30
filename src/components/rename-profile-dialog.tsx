import type { PropsWithOverlays, UseDisclosureOptions } from '@overlastic/react'
import { AlertDialog, Button, Input } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 改名结果：新名称 + 描述（确认后经 overlastic promise 返回） */
export interface RenameProfileValue {
  name: string
  description: string
}

export interface RenameProfileDialogProps
  extends PropsWithOverlays<
    { currentName: string, currentDescription: string },
    RenameProfileValue
  > {}

/**
 * 重命名档案对话框（overlastic 模式：状态在组件内部，输入框始终可编辑；
 * 确认时把 { name, description } 作为 promise 结果返回）。
 *
 * 只改 manifest 展示元信息（目录 id 不变），见 service::profile::update_meta。
 */
export function RenameProfileDialog(props: RenameProfileDialogProps) {
  // 库的 useDisclosure 把 props 类型固定为 void 结果形态；这里只做类型收窄，
  // 结果类型仍由 PropsWithOverlays 的泛型参数提供（onConfirm 实参不变）。
  const disclosure = useDisclosure({
    props: props as unknown as UseDisclosureOptions['props'],
    delay: 300,
  })
  const { t } = useTranslation()
  const [name, setName] = useState(props.currentName)
  const [description, setDescription] = useState(props.currentDescription)

  function submit() {
    const trimmed = name.trim()
    if (!trimmed)
      return
    disclosure.confirm({ name: trimmed, description: description.trim() })
  }

  return (
    <AlertDialog onOpenChange={disclosure.cancel} isOpen={disclosure.visible}>
      <AlertDialog.Backdrop>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="default" />
              <AlertDialog.Heading>
                {t('profiles.rename_confirm_title', { name: props.currentName })}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="flex flex-col gap-2">
                <Input
                  autoFocus
                  variant="secondary"
                  className="h-8 rounded-md"
                  placeholder={t('profiles.rename_name')}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      submit()
                  }}
                />
                <Input
                  variant="secondary"
                  className="h-8 rounded-md"
                  placeholder={t('profiles.rename_description')}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button className="rounded-md" variant="tertiary" onPress={disclosure.cancel}>
                {t('buttons.cancel')}
              </Button>
              <Button
                className="rounded-md"
                variant="primary"
                isDisabled={!name.trim()}
                onPress={submit}
              >
                {t('profiles.rename_confirm')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )
}
