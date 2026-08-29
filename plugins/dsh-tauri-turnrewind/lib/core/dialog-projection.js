/**
 * The `turnrewind` session projection: folds the session log and surfaces the
 * unsupported-workspace heads-up messages this plugin injected, so the client
 * half can raise a dialog from the session list snapshot it already receives.
 * Pure and unit-tested; registration is the only effect in index.js.
 */

export const UNSUPPORTED_MARKER = '[Turn rewind unavailable]'

const MAX_TRACKED_NOTICES = 20

/**
 * Extract the dialog payload from one committed session event.
 * Matches the injected message by plugin source first, falling back to the
 * text marker in case a host version drops the source field.
 */
export function extractUnsupportedNotice(event) {
  if (event?.type !== 'user/message')
    return undefined
  const message = event.data
  const text = Array.isArray(message?.content)
    ? message.content.find(part => part?.type === 'text')?.text
    : undefined
  const source = message?.source
  const matched = (source?.plugin === 'dsh-tauri-turnrewind' && source?.form === 'undo-unavailable-notice')
    || (typeof text === 'string' && text.startsWith(UNSUPPORTED_MARKER))
  if (!matched || typeof message?.id !== 'string')
    return undefined
  const reason = typeof text === 'string' ? /^Reason: (.+)$/mu.exec(text)?.[1] : undefined
  return { id: message.id, reason: reason ?? '' }
}

function parseNoticesValue(value) {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.notices))
    throw new Error('TURNREWIND_PROJECTION_SHAPE: expected { notices: Array<{ id, reason }> }')
  return value
}

/**
 * Build the `turnrewind` projection unit. Registered on
 * `ctx.sessionProjections`; the registry requires `.parse` validators (zod in
 * other plugins) — hand-rolled ones keep this plugin dependency-free.
 */
export function createDialogProjection() {
  return {
    key: 'turnrewind',
    stateVersion: 1,
    stateSchema: { parse: parseNoticesValue },
    init: () => ({ notices: [] }),
    apply(state, event) {
      const notice = extractUnsupportedNotice(event)
      if (!notice || state.notices.some(existing => existing.id === notice.id))
        return state
      return { notices: [...state.notices, notice].slice(-MAX_TRACKED_NOTICES) }
    },
    wire: {
      viewSchema: { parse: parseNoticesValue },
      view: state => ({ notices: state.notices }),
    },
  }
}
