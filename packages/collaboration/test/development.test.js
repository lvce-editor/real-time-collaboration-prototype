import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import * as Y from 'yjs'
import { fixture, client } from './helpers.js'

test('development bootstrap assigns distinct identities/colors and only the first host', async () => {
  const f = await fixture({ development: true })
  try {
    const identities = await Promise.all(Array.from({ length: 10 }, async () => {
      const response = await fetch(f.url + '/api/dev', { method: 'POST', body: '{}' })
      assert.equal(response.status, 200)
      return response.json()
    }))
    assert.equal(new Set(identities.map(x => x.id)).size, 10)
    assert.equal(new Set(identities.map(x => x.session)).size, 1)
    const members = [...f.sessions.values()][0].members.values().toArray()
    assert.deepEqual(members.map(x => x.name), Array.from({ length: 10 }, (_, i) => `user-${i + 1}`))
    assert.equal(new Set(members.map(x => x.color)).size, 10)
    assert.deepEqual(members.map(x => x.role), ['host', ...Array(9).fill('reader')])
  } finally { await f.close() }
})

test('development endpoint is opt-in and origin protected', async () => {
  for (const development of [false, true]) {
    const f = await fixture({ development })
    try {
      const response = await fetch(f.url + '/api/dev', { method: 'POST', body: '{}', headers: development ? { origin: 'http://foreign.invalid' } : {} })
      assert.equal(response.status, 400)
      assert.equal(f.sessions.size, 0)
    } finally { await f.close() }
  }
})

test('signaling stays within authenticated session and only committed edits get signed', async () => {
  const f = await fixture({ development: true })
  try {
    const join = async () => (await fetch(f.url + '/api/dev', { method: 'POST', body: '{}' })).json()
    const hc = await join(), gc = await join()
    const h = await client(f.url, hc), g = await client(f.url, gc)
    const snapshot = await h.wait('snapshot'); await g.wait('snapshot')
    const outsider = await client(f.url, f.create('Other'))
    const otherSnapshot = await outsider.wait('snapshot')
    h.send({ type: 'signal', to: gc.id, description: { type: 'offer', sdp: 'test' } })
    assert.equal((await g.wait('signal')).from, hc.id)
    h.send({ type: 'signal', to: otherSnapshot.self.id, description: { type: 'offer' } })
    h.send({ type: 'ping' }); await h.wait('pong')
    assert.equal(outsider.messages.some(x => x.type === 'signal'), false)
    const doc = new Y.Doc(); doc.getText('README.md').insert(0, 'Signed')
    const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'); doc.destroy()
    h.send({ type: 'update', update, sequence: 1 })
    const envelope = await h.wait('peer-relay')
    const key = createPublicKey({ key: snapshot.peerKey, format: 'jwk' })
    assert.equal(verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64')), true)
    assert.equal(verify(null, Buffer.from(envelope.payload + ' '), key, Buffer.from(envelope.signature, 'base64')), false)
    assert.equal(JSON.parse(envelope.payload).session, hc.session)
    g.send({ type: 'update', update, sequence: 1 })
    assert.match((await g.wait('error')).message, /Write access/)
    assert.equal(g.messages.some(x => x.type === 'peer-relay'), false)
  } finally { await f.close() }
})
