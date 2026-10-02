import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { applyLocalText, localOrigin, relativeSelections, resolveSelections } from '../src/native/binding.ts'

test('native inserts and deletes converge without echoing remote changes', () => {
  const a = new Y.Doc(), b = new Y.Doc()
  try {
    a.getText('file').insert(0, 'abcdef')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    let outgoingA = [], outgoingB = []
    a.on('update', (update, origin) => { if (origin === localOrigin) outgoingA.push(update) })
    b.on('update', (update, origin) => { if (origin === localOrigin) outgoingB.push(update) })
    applyLocalText(a.getText('file'), 'abcdef', 'aHOSTbcdef')
    applyLocalText(b.getText('file'), 'abcdef', 'abef')
    assert.equal(outgoingA.length, 1)
    assert.equal(outgoingB.length, 1)
    Y.applyUpdate(a, outgoingB[0], 'remote')
    Y.applyUpdate(b, outgoingA[0], 'remote')
    assert.equal(a.getText('file').toString(), 'aHOSTbef')
    assert.equal(b.getText('file').toString(), 'aHOSTbef')
    assert.equal(outgoingA.length, 1)
    assert.equal(outgoingB.length, 1)
  } finally { a.destroy(); b.destroy() }
})

test('native selections retain their CRDT anchors through remote multiline edits', () => {
  const doc = new Y.Doc()
  try {
    const text = doc.getText('file')
    text.insert(0, 'first\nsecond')
    const selection = relativeSelections(text, [1, 1, 1, 4])
    doc.transact(() => { text.insert(0, 'new\n'); text.delete(11, 2) }, 'remote')
    assert.deepEqual(resolveSelections(text, selection), [2, 1, 2, 2])
  } finally { doc.destroy() }
})

test('stale editor commands cannot overwrite a newer replica', () => {
  const doc = new Y.Doc()
  try {
    const text = doc.getText('file')
    text.insert(0, 'authority')
    assert.throws(() => applyLocalText(text, 'old', 'old+local'), /stale replica/)
    assert.equal(text.toString(), 'authority')
  } finally { doc.destroy() }
})
