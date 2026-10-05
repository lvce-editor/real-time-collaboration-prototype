import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { fixture, client } from './helpers.ts'
import { encode, decode } from '../src/session-server.ts'

async function setup(t, options = {}) {
  const f = await fixture(options); t.after(f.close)
  const host = f.create('Host', { 'main.js': 'abc', 'other.txt': 'other' })
  const guest = f.join(host.session, 'Guest')
  const h = await client(f.url, host, 'batched'), g = await client(f.url, guest, 'batched')
  const hs = await h.wait('snapshot'), gs = await g.wait('snapshot')
  await h.wait('roster'); await g.wait('roster')
  return { f, host, guest, h, g, hs, gs }
}
async function grant(h, g, guest) {
  h.send({ type: 'permission', id: guest.id, role: 'writer' })
  await g.wait(m => m.type === 'member' && m.member.id === guest.id && m.member.role === 'writer')
}
function edit(snapshot, character, index = 1) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, decode(snapshot.update))
  let update; doc.on('update', bytes => { update = encode(bytes) })
  doc.getText('main.js').insert(index, character)
  return { doc, update }
}
test('HTTP create/join supplies distinct credentials and rejects unknown sessions', async t => {
  const f = await fixture(); t.after(f.close)
  const post = async (path, body) => fetch(f.url + path, { method: 'POST', body: JSON.stringify(body) })
  const h = await (await post('/api/create', { name: 'Host' })).json()
  const g = await (await post('/api/join', { session: h.session })).json()
  assert.notEqual(h.token, g.token)
  assert.equal(g.session, h.session)
  assert.equal((await post('/api/join', { session: 'missing' })).status, 400)
})
test('read-only defaults are enforced on forged document updates', async t => {
  const { f, host, g, gs } = await setup(t)
  assert.equal(gs.self.role, 'reader')
  const { update, doc } = edit(gs, 'FORGED'); t.after(() => doc.destroy())
  g.send({ type: 'update', update })
  assert.match((await g.wait('error')).message, /Write access/)
  assert.equal(f.sessions.get(host.session).doc.getText('main.js').toString(), 'abc')
})
test('guest cannot approve itself', async t => {
  const { g, guest } = await setup(t)
  g.send({ type: 'permission', id: guest.id, role: 'writer' })
  assert.match((await g.wait('error')).message, /Host approval/)
})
test('request and approval enable edits; revocation rejects subsequent updates', async t => {
  const { h, g, guest, gs, f, host } = await setup(t)
  g.send({ type: 'request-write' })
  await h.wait(m => m.type === 'member' && m.member.requested)
  await grant(h, g, guest)
  const { doc, update } = edit(gs, 'X'); t.after(() => doc.destroy())
  g.send({ type: 'update', update, sequence: 1 })
  assert.equal((await g.wait('ack')).sequence, 1)
  assert.equal(f.sessions.get(host.session).doc.getText('main.js').toString(), 'aXbc')
  h.send({ type: 'permission', id: guest.id, role: 'reader' })
  await g.wait(m => m.type === 'member' && m.member.id === guest.id && m.member.role === 'reader')
  g.send({ type: 'update', update })
  await g.wait('error')
})
test('concurrent same-position inserts converge and retain both contributions', async t => {
  const { h, g, hs, gs, guest } = await setup(t)
  await grant(h, g, guest)
  const a = edit(hs, 'HOST'), b = edit(gs, 'GUEST')
  t.after(() => { a.doc.destroy(); b.doc.destroy() })
  h.send({ type: 'update', update: a.update }); g.send({ type: 'update', update: b.update })
  Y.applyUpdate(a.doc, decode((await h.wait('update')).update))
  Y.applyUpdate(b.doc, decode((await g.wait('update')).update))
  assert.equal(a.doc.getText('main.js').toString(), b.doc.getText('main.js').toString())
  assert.match(a.doc.getText('main.js').toString(), /HOST/)
  assert.match(a.doc.getText('main.js').toString(), /GUEST/)
})
test('duplicate updates are idempotent and late joins receive authoritative project', async t => {
  const { h, hs, f, host } = await setup(t)
  const { update, doc } = edit(hs, 'ONCE'); t.after(() => doc.destroy())
  h.send({ type: 'update', update }); await h.wait('ack')
  h.send({ type: 'update', update }); await h.wait('ack')
  const late = await client(f.url, f.join(host.session, 'Late'))
  const snapshot = await late.wait('snapshot')
  const result = new Y.Doc(); t.after(() => result.destroy()); Y.applyUpdate(result, decode(snapshot.update))
  assert.equal(result.getText('main.js').toString(), 'aONCEbc')
  assert.equal(result.getText('other.txt').toString(), 'other')
})
test('reconnect preserves identity, role and committed state', async t => {
  const { h, g, guest, f } = await setup(t)
  await grant(h, g, guest)
  g.socket.close(); await new Promise(resolve => g.socket.once('close', resolve))
  const replacement = await client(f.url, guest)
  const snapshot = await replacement.wait('snapshot')
  assert.equal(snapshot.self.id, guest.id)
  assert.equal(snapshot.self.role, 'writer')
})
test('departure and cursor identity are authoritative', async t => {
  const { h, g, guest } = await setup(t)
  g.send({ type: 'cursor', id: 'spoof', file: 'main.js', cursor: { head: {}, anchor: {} } })
  assert.equal((await h.wait('cursor')).id, guest.id)
  g.socket.close()
  await h.wait(m => m.type === 'member' && m.member.id === guest.id && !m.member.online)
})
test('relative cursor positions move with concurrent text insertions', () => {
  const doc = new Y.Doc(); const text = doc.getText('x'); text.insert(0, 'abc')
  const position = Y.createRelativePositionFromTypeIndex(text, 2)
  text.insert(0, 'prefix')
  assert.equal(Y.createAbsolutePositionFromRelativePosition(position, doc).index, 8)
  doc.destroy()
})
test('malformed writer update cannot corrupt document', async t => {
  const { h, f, host } = await setup(t)
  h.send({ type: 'update', update: 'broken' })
  await h.wait('error')
  assert.equal(f.sessions.get(host.session).doc.getText('main.js').toString(), 'abc')
})
test('session credentials cannot be used in a different session', async t => {
  const { f, guest } = await setup(t)
  const other = f.create('Other')
  const bad = await client(f.url, { ...guest, session: other.session })
  assert.match((await bad.wait('error')).message, /Invalid credentials/)
})
test('HTTP routes do not expose LVCE filesystem or traversal paths', async t => {
  const f = await fixture(); t.after(f.close)
  for (const path of ['/remote/etc/passwd', '/../../package.json', '/api/anything']) assert.equal((await fetch(f.url + path)).status, 404)
  assert.equal((await fetch(f.url + '/api/create', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' })).status, 400)
})
test('project limits and traversal paths are rejected', async t => {
  const f = await fixture(); t.after(f.close)
  assert.throws(() => f.create('H', { '../secret': 'x' }), /Invalid text/)
  assert.throws(() => f.create('H', { 'large': 'x'.repeat(500_000) }), /Project limit/)
  assert.throws(() => f.create('H', {}), /Project limit/)
})
test('idle sessions expire and release documents', async t => {
  const f = await fixture({ idleMs: 15 }); t.after(f.close)
  const host = f.create('H')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.throws(() => f.join(host.session, 'G'), /expired/)
})
test('concurrent delete and insert converge without discarding the insertion', async t => {
  const { h, g, guest, hs, gs } = await setup(t)
  await grant(h, g, guest)
  const a = new Y.Doc(), b = new Y.Doc()
  t.after(() => { a.destroy(); b.destroy() })
  Y.applyUpdate(a, decode(hs.update)); Y.applyUpdate(b, decode(gs.update))
  let deletion, insertion
  a.once('update', data => { deletion = encode(data) }); a.getText('main.js').delete(0, 3)
  b.once('update', data => { insertion = encode(data) }); b.getText('main.js').insert(1, 'retained')
  h.send({ type: 'update', update: deletion }); g.send({ type: 'update', update: insertion })
  Y.applyUpdate(a, decode((await h.wait('update')).update))
  Y.applyUpdate(b, decode((await g.wait('update')).update))
  assert.equal(a.getText('main.js').toString(), 'retained')
  assert.equal(a.getText('main.js').toString(), b.getText('main.js').toString())
})
test('connection replacement does not mark the new participant offline', async t => {
  const { h, g, guest, f } = await setup(t)
  const replacement = await client(f.url, guest)
  await replacement.wait('snapshot')
  await new Promise<void>(resolve => g.socket.readyState === 3 ? resolve() : g.socket.once('close', resolve))
  replacement.send({ type: 'request-write' })
  const change = await h.wait(m => m.type === 'member' && m.member.requested)
  assert.equal(change.member.online, true)
})
test('participant capacity is explicit and does not mutate the session on failure', async t => {
  const f = await fixture({ maxMembers: 2 }); t.after(f.close)
  const host = f.create('H'); f.join(host.session, 'G')
  assert.throws(() => f.join(host.session, 'Overflow'), /participant limit/)
  assert.equal(f.sessions.get(host.session).members.size, 2)
})

test('import normalizes line endings to the native editor document model', async t => {
  const f = await fixture(); t.after(f.close)
  const host = f.create('Host', { 'file.txt': 'a\r\nb\rc' })
  assert.equal(f.sessions.get(host.session).doc.getText('file.txt').toString(), 'a\nb\nc')
})

test('batched joins deliver a complete roster and ordered presence to modern and legacy clients', async t => {
  const f = await fixture(); t.after(f.close)
  const host = f.create('Host')
  const h = await client(f.url, host, 'batched')
  assert.equal((await h.wait('snapshot')).presencePending, true)
  assert.deepEqual((await h.wait('roster')).members.map(m => m.id), [host.id])
  const legacyAuth = f.join(host.session, 'Legacy')
  const legacy = await client(f.url, legacyAuth)
  const legacySnapshot = await legacy.wait('snapshot')
  assert.equal(legacySnapshot.presencePending, false)
  const auth = Array.from({ length: 40 }, (_, i) => f.join(host.session, `Guest ${i}`))
  const guests = await Promise.all(auth.map(a => client(f.url, a, 'batched')))
  const rosters = await Promise.all(guests.map(async g => {
    assert.equal((await g.wait('snapshot')).presencePending, true)
    return (await g.wait('roster')).members
  }))
  const expected = new Set([host.id, legacyAuth.id, ...auth.map(a => a.id)])
  // The last joiner's roster contains everyone; earlier snapshots plus later
  // ordered deltas must also converge to the full directory.
  const apply = (map, message) => {
    if (message.type === 'member') map.set(message.member.id, message.member)
    if (message.type === 'members') for (const member of message.members) map.set(member.id, member)
  }
  await h.wait(m => m.type === 'members' && m.members.some(p => p.id === auth.at(-1).id))
  await legacy.wait(m => m.type === 'member' && m.member.id === auth.at(-1).id)
  for (const [i, g] of guests.entries()) {
    const members = new Map(rosters[i].map(m => [m.id, m]))
    if (!members.has(auth.at(-1).id)) apply(members, await g.wait(m => m.type === 'members' && m.members.some(p => p.id === auth.at(-1).id)))
    for (const message of g.messages) apply(members, message)
    assert.deepEqual(new Set([...members.values()].filter(m => m.online).map(m => m.id)), expected)
  }
  // A permission change flushes pending joins before changing authority. A stale
  // reader join event must never overwrite its subsequent grant or revocation.
  h.send({ type: 'permission', id: auth[0].id, role: 'writer' })
  await guests[0].wait(m => m.type === 'member' && m.member.id === auth[0].id && m.member.role === 'writer')
  const replacement = await client(f.url, auth[0], 'batched')
  const snapshot = await replacement.wait('snapshot')
  assert.equal(snapshot.self.role, 'writer')
  await replacement.wait('roster')
  replacement.socket.close()
  await h.wait(m => m.type === 'members' && m.members.some(p => p.id === auth[0].id && !p.online))
  await legacy.wait(m => m.type === 'member' && m.member.id === auth[0].id && !m.member.online)
})

test('slow consumers close with 1013 and recover committed state through a batched snapshot', async t => {
  const f = await fixture(); t.after(f.close)
  const host = f.create('Host', { 'main.js': 'abc' })
  const guest = f.join(host.session, 'Slow')
  const h = await client(f.url, host), g = await client(f.url, guest, 'batched')
  const hs = await h.wait('snapshot'); await g.wait('snapshot'); await g.wait('roster')
  const serverSocket = f.sessions.get(host.session).members.get(guest.token).socket
  // Deterministically inject outbound backpressure at the real delivery seam.
  Object.defineProperty(serverSocket, 'bufferedAmount', { value: 2_000_001 })
  const closed = new Promise<number>(resolve => g.socket.once('close', resolve))
  const { doc, update } = edit(hs, 'COMMITTED'); t.after(() => doc.destroy())
  h.send({ type: 'update', update }); await h.wait('ack')
  assert.equal(await closed, 1013)
  const recovered = await client(f.url, guest, 'batched')
  const snapshot = await recovered.wait('snapshot'); await recovered.wait('roster')
  const replica = new Y.Doc(); t.after(() => replica.destroy()); Y.applyUpdate(replica, decode(snapshot.update))
  assert.equal(replica.getText('main.js').toString(), 'aCOMMITTEDbc')
  assert.equal(snapshot.self.role, 'reader')
})

test('late joins and reconnects receive current cursors without asking every peer to republish', async t => {
  const f = await fixture(); t.after(f.close)
  const host = f.create('Host', { 'main.js': 'abc' })
  const h = await client(f.url, host, 'batched'); await h.wait('snapshot'); await h.wait('roster')
  h.send({ type: 'cursor', id: 'spoof', file: 'main.js', cursor: { anchor: {}, head: {} } })
  h.send({ type: 'ping' }); await h.wait('pong')
  const guest = f.join(host.session, 'Late')
  const g = await client(f.url, guest, 'batched'); await g.wait('snapshot')
  const roster = await g.wait('roster')
  assert.equal(roster.cursors.length, 1)
  assert.equal(roster.cursors[0].id, host.id)
  assert.equal(roster.cursors[0].file, 'main.js')
  h.socket.close(); await g.wait(m => m.type === 'member' && m.member.id === host.id && !m.member.online)
  const replacement = await client(f.url, guest, 'batched'); await replacement.wait('snapshot')
  assert.deepEqual((await replacement.wait('roster')).cursors, [])
})
