import assert from 'node:assert/strict'
import { it } from 'vitest'
import { createDialogProjection, extractUnsupportedNotice } from '../lib/core/dialog-projection.js'

function unsupportedEvent(id, reason, withSource = true) {
  const text = `[Turn rewind unavailable]\nUndo is disabled for this workspace.\nReason: ${reason}\n\nTurns here still run normally.`
  const message = { id, role: 'user', content: [{ type: 'text', text }] }
  if (withSource)
    message.source = { kind: 'plugin', plugin: 'dsh-tauri-turnrewind', form: 'undo-unavailable-notice', sections: [] }
  return { type: 'user/message', seq: 1, data: message }
}

it('extracts unsupported notices from plugin messages with and without source', () => {
  const withSource = extractUnsupportedNotice(unsupportedEvent('turnrewind-notice-a', 'TURNREWIND_WORKSPACE_UNSUPPORTED: home'))
  assert.deepEqual(withSource, { id: 'turnrewind-notice-a', reason: 'TURNREWIND_WORKSPACE_UNSUPPORTED: home' })
  const byText = extractUnsupportedNotice(unsupportedEvent('turnrewind-notice-b', 'TURNREWIND_WORKSPACE_TOO_LARGE: budget', false))
  assert.deepEqual(byText, { id: 'turnrewind-notice-b', reason: 'TURNREWIND_WORKSPACE_TOO_LARGE: budget' })
})

it('ignores unrelated session events', () => {
  assert.equal(extractUnsupportedNotice({ type: 'turn/start', data: { turn: 1 } }), undefined)
  assert.equal(extractUnsupportedNotice({
    type: 'user/message',
    data: { id: 'plain', role: 'user', content: [{ type: 'text', text: '你好' }] },
  }), undefined)
  assert.equal(extractUnsupportedNotice(undefined), undefined)
})

it('folds notices into the view, dedupes by id, and caps the list', () => {
  const projection = createDialogProjection()
  let state = projection.init()
  state = projection.apply(state, unsupportedEvent('notice-1', 'r1'))
  assert.equal(projection.wire.view(state).notices.length, 1)
  const unchanged = state
  state = projection.apply(state, unsupportedEvent('notice-1', 'r1'))
  assert.equal(state, unchanged)
  for (let index = 2; index <= 25; index += 1)
    state = projection.apply(state, unsupportedEvent(`notice-${index}`, `r${index}`))
  const view = projection.wire.view(state)
  assert.equal(view.notices.length, 20)
  assert.equal(view.notices.at(-1).id, 'notice-25')
  assert.equal(view.notices[0].id, 'notice-6')
})

it('validates persisted state through the schema face', () => {
  const projection = createDialogProjection()
  assert.deepEqual(projection.stateSchema.parse({ notices: [] }), { notices: [] })
  assert.throws(() => projection.stateSchema.parse({ broken: true }), /TURNREWIND_PROJECTION_SHAPE/)
  assert.throws(() => projection.wire.viewSchema.parse(null), /TURNREWIND_PROJECTION_SHAPE/)
})
