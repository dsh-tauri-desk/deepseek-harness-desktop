import type { PropsWithOverlays } from '@overlastic/react'
import { Cpu, FaceRobot, LogoWindows, PersonPencil, Puzzle } from '@gravity-ui/icons'
import { useEventBus } from '@hairy/react-lib'
import { cn, Modal } from '@heroui/react'
import { useDisclosure } from '@overlastic/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Case, If, Switch } from 'react-if-lite'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { ConfigCore } from './config-core'
import { ConfigDebug } from './config-debug'
import { ConfigPet } from './config-pet'
import { ConfigPlugin } from './config-plugin'
import { ConfigProfile } from './config-profile'

export interface ConfigDialogProps extends PropsWithOverlays {}

export function ConfigDialog(props: ConfigDialogProps) {
  const disclosure = useDisclosure({ props })
  const { t } = useTranslation()
  // 异常插件数：在「插件」Tab 上给出红点/角标，方便用户直接感知出问题的插件
  const { plugins } = useDshPlugins()
  const abnormalCount = plugins.filter(p => p.error != null).length

  const navs = [
    { label: t('config.application'), value: 'application', icon: LogoWindows },
    { label: t('config.profiles'), value: 'profiles', icon: PersonPencil },
    { label: t('config.plugins'), value: 'plugins', icon: Puzzle },
    { label: t('config.harness'), value: 'harness', icon: Cpu },
    { label: t('config.pet'), value: 'pet', icon: FaceRobot },
  ]

  const [activeTab, setActiveTab] = useState('application')

  useEventBus('config:dialog:hidden').on(disclosure.cancel)

  return (
    <Modal isOpen={disclosure.visible} onOpenChange={disclosure.cancel}>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="w-[800px] max-w-[calc(100vw-48px)] pr-2.5 h-screen">
            <Modal.CloseTrigger />
            <Modal.Header className="mb-3">
              <Modal.Heading>
                {t('app.config')}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex gap-6 pr-0 h-screen">
              <aside className="w-[164px]">
                <nav className="flex flex-col gap-2 w-full">
                  {navs.map((item) => {
                    const isActive = item.value === activeTab
                    return (
                      <button
                        key={item.value}
                        onClick={() => setActiveTab(item.value)}
                        className={cn(
                          'text-foreground h-[40px] rounded-md flex items-center gap-2 py-[9px] px-[16px] hover:bg-background-secondary cursor-pointer',
                          isActive ? 'bg-background-secondary' : '',
                        )}
                      >
                        <item.icon className="w-5 h-5 mr-2" />
                        <span>{item.label}</span>
                        <If cond={item.value === 'plugins' && abnormalCount > 0}>
                          <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-danger text-[10px] font-semibold leading-none text-white">
                            {abnormalCount}
                          </span>
                        </If>
                      </button>
                    )
                  })}
                </nav>
              </aside>
              <div className="flex flex-col flex-1 overflow-auto min-h-0 pr-2.5">
                <Switch value={activeTab} as="div">
                  <Case cond="application">
                    <ConfigDebug />
                  </Case>
                  <Case cond="profiles">
                    <ConfigProfile />
                  </Case>
                  <Case cond="plugins">
                    <ConfigPlugin />
                  </Case>
                  <Case cond="harness">
                    <ConfigCore />
                  </Case>
                  <Case cond="pet">
                    <ConfigPet />
                  </Case>
                </Switch>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
