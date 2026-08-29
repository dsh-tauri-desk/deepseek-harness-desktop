import type { InternalPluginsPhasePayload } from '@/store/modules/harness/types'

export type InternalPluginPhaseTranslate = (
  key: string,
  options?: Record<string, number>,
) => string

export function internalPluginReason(
  payload: InternalPluginsPhasePayload,
  previousReason: string,
  translate: InternalPluginPhaseTranslate,
): string {
  switch (payload.detail) {
    case 'waiting':
      return translate('status.internal_waiting')
    case 'checking':
      return translate('status.internal_checking', { total: payload.total })
    case 'installing':
      return translate('status.internal_installing', { total: payload.total })
    case 'heartbeat':
      return previousReason
    case 'done':
      return translate('status.internal_done', { total: payload.total })
    case 'timeout':
      return translate('status.internal_timeout')
    case 'cancelled':
      return translate('status.internal_cancelled')
  }
}
