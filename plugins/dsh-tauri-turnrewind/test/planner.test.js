import assert from 'node:assert/strict'
import { it } from 'vitest'
import { aggregatePathPlan, classifyUndo, collectDescendantTurns } from '../lib/core/planner.js'

it('collects a selected turn subtree in leaf-first order', () => {
  const root = { turn_id: 'p' }
  const children = new Map([
    ['p', [{ turn_id: 'a' }, { turn_id: 'c' }]],
    ['a', [{ turn_id: 'b' }]],
    ['c', []],
    ['b', []],
  ])
  assert.deepEqual(collectDescendantTurns(root, children).map(turn => turn.turn_id), ['b', 'a', 'c', 'p'])
})

it('aggregates paths without duplicating overlapping files', () => {
  const turns = [{ turn_id: 'b' }, { turn_id: 'a' }]
  const paths = new Map([
    ['b', ['src/a.ts', 'src/b.ts']],
    ['a', ['src/a.ts']],
  ])
  assert.deepEqual(aggregatePathPlan(turns, turn => paths.get(turn.turn_id)).map(entry => entry.path), ['src/a.ts', 'src/b.ts'])
})

it('classifies stale content as a conflict', () => {
  assert.equal(classifyUndo({ kind: 'file', digest: 'same' }, { kind: 'file', digest: 'same' }), 'safe')
  assert.equal(classifyUndo({ kind: 'file', digest: 'new' }, { kind: 'file', digest: 'old' }), 'conflict')
  assert.equal(classifyUndo({ kind: 'absent', digest: null }, { kind: 'file', digest: 'old' }), 'conflict')
})
