export function collectDescendantTurns(turn, childrenByParent) {
  const result = []
  const visit = (current) => {
    for (const child of childrenByParent.get(current.turn_id) ?? []) {
      visit(child)
      result.push(child)
    }
  }
  visit(turn)
  result.push(turn)
  return result
}

export function aggregatePathPlan(turns, pathReader) {
  const byPath = new Map()
  for (const turn of turns) {
    for (const path of pathReader(turn)) {
      const current = byPath.get(path)
      if (!current) {
        byPath.set(path, { path, firstTurn: turn.turn_id, lastTurn: turn.turn_id })
      }
      else {
        current.lastTurn = turn.turn_id
      }
    }
  }
  return [...byPath.values()]
}

export function classifyUndo(currentState, expectedState) {
  if (currentState.kind !== expectedState.kind)
    return 'conflict'
  if (currentState.digest !== expectedState.digest)
    return 'conflict'
  return 'safe'
}
