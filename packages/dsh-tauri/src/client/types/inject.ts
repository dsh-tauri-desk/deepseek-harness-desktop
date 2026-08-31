export type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

export interface LocaleService {
  register: (namespace: string, locale: string, dict: Record<string, unknown>) => () => void
  getLocale: () => { active: string }
  subscribe: (onChange: () => void) => () => void
}
