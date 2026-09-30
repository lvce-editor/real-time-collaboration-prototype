import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { fixture } from '../test/helpers.js'
import { encode, decode } from '../src/session-server.js'
const count = Number(process.argv[2]), started = performance.now()
const f = await fixture()
const credentials = f.create('Host', { 'benchmark.txt': '' })
const clients = [], sent = new Map(), latency = []
let connected = 0, deliveries = 0, peakRss = 0, editStarted = 0
const progress = () => ({ count, connected, setupMs: Math.round(performance.now() - started), peakRssBytes: peakRss })
const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); process.send?.(progress()) }, 1000)
async function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace('http', 'ws') + '/collaboration')
    const doc = new Y.Doc()
    const client = { socket, doc, auth }
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', ...auth })))
    socket.on('error', reject)
    socket.on('message', raw => {
      const message = JSON.parse(raw)
      if (message.type === 'snapshot') { Y.applyUpdate(doc, decode(message.update)); connected++; clients.push(client); resolve(client) }
      if (message.type === 'update') {
        Y.applyUpdate(doc, decode(message.update)); deliveries++
        if (sent.has(message.update)) latency.push(performance.now() - sent.get(message.update))
      }
      if (message.type === 'error') reject(new Error(message.message))
    })
  })
}
try {
  await connect(credentials)
  for (let i = 1; i < count; i += 20) await Promise.all(Array.from({ length: Math.min(20, count - i) }, (_, j) => connect(f.join(credentials.session, `User ${i + j}`))))
  const setupMs = performance.now() - started
  const writers = Math.min(10, count)
  // Set permissions through the authoritative host connection, then await each
  // writer's role event before producing concurrent edits.
  for (let i = 1; i < writers; i++) {
    await new Promise(resolve => {
      const listener = raw => { const m = JSON.parse(raw); if (m.type === 'member' && m.member.id === clients[i].auth.id && m.member.role === 'writer') { clients[i].socket.off('message', listener); resolve() } }
      clients[i].socket.on('message', listener)
      clients[0].socket.send(JSON.stringify({ type: 'permission', id: clients[i].auth.id, role: 'writer' }))
    })
  }
  editStarted = performance.now()
  for (let i = 0; i < writers; i++) {
    const c = clients[i]
    const listener = update => { const data = encode(update); sent.set(data, performance.now()); c.socket.send(JSON.stringify({ type: 'update', update: data, sequence: i })) }
    c.doc.once('update', listener)
    c.doc.getText('benchmark.txt').insert(0, `[writer-${i}]`)
  }
  const expected = (count - 1) * writers
  while (deliveries < expected) await new Promise(resolve => setTimeout(resolve, 10))
  const editMs = performance.now() - editStarted
  const text = f.sessions.get(credentials.session).doc.getText('benchmark.txt').toString()
  const converged = clients.every(c => c.doc.getText('benchmark.txt').toString() === text) && Array.from({ length: writers }, (_, i) => `[writer-${i}]`).every(marker => text.includes(marker))
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  latency.sort((a, b) => a - b)
  process.send?.({ count, connected, status: converged ? 'passed' : 'failed', converged, setupMs: Math.round(setupMs), editMs: Math.round(editMs), writers, deliveries, deliveriesPerSecond: Math.round(deliveries / editMs * 1000), p50Ms: Math.round(latency[Math.floor(latency.length * .5)] || 0), p95Ms: Math.round(latency[Math.floor(latency.length * .95)] || 0), peakRssBytes: peakRss })
} catch (error) { process.send?.({ ...progress(), status: 'failed', reason: error.message }) }
finally { clearInterval(monitor); await f.close(); for (const c of clients) c.doc.destroy(); process.disconnect?.() }
