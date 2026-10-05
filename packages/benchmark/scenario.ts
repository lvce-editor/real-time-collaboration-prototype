import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { gunzipSync } from 'node:zlib'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { benchmarkFixture } from './fixture.ts'
import { encode, decode, type Credentials } from '@lvce-editor/real-time-collaboration/server'
const count = Number(process.argv[2]), started = performance.now()
const connectBatch = Number(process.env.BENCHMARK_CONNECT_BATCH ?? 20)
if (!Number.isInteger(connectBatch) || connectBatch < 1 || connectBatch > 1000) throw new Error('Invalid connection batch')
const f = await benchmarkFixture(process.env.BENCHMARK_PROCESSES === 'separate')
const credentials = f.credentials
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable()
const cpu = process.cpuUsage()
type BenchmarkClient = { socket: WebSocket; doc: Y.Doc; auth: Credentials }
const clients: BenchmarkClient[] = [], sent = new Map<string, number>(), latency: number[] = []
let connected = 0, deliveries = 0, peakRss = 0, editStarted = 0, unexpectedCloses = 0, receivedBytes = 0, receivedFrames = 0, peakHeap = 0
let finishing = false
// Protocol load generators share immutable decoded presence frames within this
// process. The bounded cache avoids measuring repeated JSON/gzip decoding as
// server capacity; every byte still traverses every real WebSocket. Browser
// processes do not share this cache, so this is explicitly not a browser limit.
const rosterCache = new Map<number, any>(), presenceCache = new Map<number, any>()
function parse(raw: Buffer, binary: boolean) {
  if (!binary) return JSON.parse(raw.toString())
  const id = raw.readDoubleBE()
  if (rosterCache.has(id)) return rosterCache.get(id)
  if (presenceCache.has(id)) return presenceCache.get(id)
  const message = JSON.parse(gunzipSync(raw.subarray(8)).toString())
  const cache = message.type === 'roster' ? rosterCache : presenceCache
  cache.set(id, message)
  const limit = message.type === 'roster' ? 8 : 128
  if (cache.size > limit) cache.delete(cache.keys().next().value!)
  return message
}
const progress = () => {
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed)
  return ({ count, connected, connectBatch, setupMs: Math.round(performance.now() - started), peakRssBytes: peakRss, peakHeapBytes: peakHeap, unexpectedCloses, receivedBytes, receivedFrames, eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6, cpuMs: (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000, ...f.metrics() })
}
const monitor = setInterval(() => process.send?.(progress()), 1000)
async function connect(auth: Credentials): Promise<BenchmarkClient> {
  return new Promise<BenchmarkClient>((resolve, reject) => {
    const socket = new WebSocket(f.url.replace('http', 'ws') + '/collaboration')
    const doc = new Y.Doc()
    const client = { socket, doc, auth }
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', ...auth, presence: 'batched' })))
    socket.on('error', reject)
    socket.on('close', (code, reason) => { if (!finishing) { unexpectedCloses++; reject(new Error(`Unexpected close ${code}: ${reason}`)) } })
    socket.on('message', (raw, binary) => {
      const bytes = raw as Buffer
      receivedFrames++; receivedBytes += bytes.length
      const message = parse(bytes, binary)
      if (message.type === 'snapshot') { Y.applyUpdate(doc, decode(message.update)); if (!message.presencePending) { connected++; clients.push(client); resolve(client) } }
      if (message.type === 'roster') { connected++; clients.push(client); resolve(client) }
      if (message.type === 'update') {
        Y.applyUpdate(doc, decode(message.update)); deliveries++
        const sentAt = sent.get(message.update)
        if (sentAt !== undefined) latency.push(performance.now() - sentAt)
      }
      if (message.type === 'error') reject(new Error(message.message))
    })
  })
}
try {
  await connect(credentials)
  for (let i = 1; i < count; i += connectBatch) await Promise.all((await f.join(i, Math.min(connectBatch, count - i))).map(connect))
  const setupMs = performance.now() - started
  const writers = Math.min(10, count)
  // Set permissions through the authoritative host connection, then await each
  // writer's role event before producing concurrent edits.
  for (let i = 1; i < writers; i++) {
    await new Promise<void>(resolve => {
      const writer = clients[i]!
      const listener = (raw: Buffer, binary: boolean) => { const m = parse(raw, binary); if (m.type === 'member' && m.member.id === writer.auth.id && m.member.role === 'writer') { writer.socket.off('message', listener); resolve() } }
      writer.socket.on('message', listener)
      clients[0]!.socket.send(JSON.stringify({ type: 'permission', id: writer.auth.id, role: 'writer' }))
    })
  }
  editStarted = performance.now()
  for (let i = 0; i < writers; i++) {
    const c = clients[i]!
    const listener = (update: Uint8Array) => { const data = encode(update); sent.set(data, performance.now()); c.socket.send(JSON.stringify({ type: 'update', update: data, sequence: i })) }
    c.doc.once('update', listener)
    c.doc.getText('benchmark.txt').insert(0, `[writer-${i}]`)
  }
  const expected = (count - 1) * writers
  while (deliveries < expected) await new Promise(resolve => setTimeout(resolve, 10))
  const editMs = performance.now() - editStarted
  const text = await f.text()
  const converged = connected === count && deliveries === expected && unexpectedCloses === 0 && clients.every(c => c.doc.getText('benchmark.txt').toString() === text) && Array.from({ length: writers }, (_, i) => `[writer-${i}]`).every(marker => text.includes(marker))
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  latency.sort((a, b) => a - b)
  process.send?.({ ...progress(), status: converged ? 'passed' : 'failed', reason: converged ? undefined : 'Replica divergence, missing writers or unexpected disconnects', converged, setupMs: Math.round(setupMs), editMs: Math.round(editMs), writers, deliveries, deliveriesPerSecond: Math.round(deliveries / editMs * 1000), p50Ms: Math.round(latency[Math.floor(latency.length * .5)] || 0), p95Ms: Math.round(latency[Math.floor(latency.length * .95)] || 0), peakRssBytes: peakRss })
} catch (error) { process.send?.({ ...progress(), status: 'failed', reason: error instanceof Error ? error.message : String(error) }) }
finally { finishing = true; delay.disable(); clearInterval(monitor); await f.close(); for (const c of clients) c.doc.destroy(); process.disconnect?.() }
