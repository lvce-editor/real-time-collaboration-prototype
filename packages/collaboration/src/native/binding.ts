import * as Y from 'yjs'

export const localOrigin = Symbol('native-editor')

// A native command runs against the current replica. Preserve unaffected CRDT
// items rather than replacing the document, including when deleting a selection.
export function applyLocalText(text: Y.Text, before: string, after: string): void {
  if (before === after) return
  if (text.toString() !== before) throw new Error('Editor command used a stale replica')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length, endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
  text.doc!.transact(() => {
    if (endBefore > start) text.delete(start, endBefore - start)
    if (endAfter > start) text.insert(start, after.slice(start, endAfter))
  }, localOrigin)
}

export function offsetAt(text: string, row: number, column: number): number {
  const lines = text.split('\n')
  const boundedRow = Math.min(row, lines.length - 1)
  let offset = 0
  for (let i = 0; i < boundedRow; i++) offset += lines[i].length + 1
  return offset + Math.min(column, lines[boundedRow].length)
}

export function positionAt(text: string, offset: number): [number, number] {
  const lines = text.slice(0, Math.max(0, Math.min(offset, text.length))).split('\n')
  return [lines.length - 1, lines.at(-1)!.length]
}

export function relativeSelections(text: Y.Text, selections: number[]): Y.RelativePosition[] {
  const value = text.toString()
  const result = []
  for (let i = 0; i < selections.length; i += 2) result.push(Y.createRelativePositionFromTypeIndex(text, offsetAt(value, selections[i], selections[i + 1])))
  return result
}

export function resolveSelections(text: Y.Text, positions: Y.RelativePosition[]): number[] {
  return positions.flatMap(position => {
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, text.doc!)
    return positionAt(text.toString(), absolute?.type === text ? absolute.index : 0)
  })
}

// One queue owns both native commands and incoming authority messages. Capturing
// the owner in each callback prevents commands for a disposed file from running.
export function createQueue(onError: (error: unknown) => void) {
  let pending = Promise.resolve()
  return (operation: () => void | Promise<void>): Promise<void> => {
    pending = pending.then(operation).catch(onError)
    return pending
  }
}
