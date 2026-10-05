import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'
import ts from 'typescript'

const source = await readFile(new URL('../src/transport-worker.ts', import.meta.url), 'utf8')
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function harness() {
  const entered = deferred(), release = deferred(), sockets: any[] = [], messages: any[] = []
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: any; onmessage: any; onclose: any; onerror: any; binaryType: string
    constructor() { sockets.push(this) }
    send() {}
    close() { this.readyState = 3 }
  }
  class DelayedResponse extends Response {
    async text() { entered.resolve(); await release.promise; return super.text() }
  }
  const context = vm.createContext({ WebSocket: Socket, Blob, DecompressionStream, Response: DelayedResponse, Date, JSON, Promise, setInterval: () => 1, clearInterval: () => {}, postMessage: m => messages.push(m), onmessage: undefined })
  vm.runInContext(script, context)
  const connect = () => {
    context.onmessage({ data: { type: 'connect', url: 'ws://fixture/collaboration', credentials: { session: 's', token: 't', id: 'i' } } })
    const socket = sockets.at(-1); socket.onopen(); return socket
  }
  const pending = () => vm.runInContext('adapter.incoming', context) as Promise<void>
  const compressed = message => {
    const frame = Buffer.concat([Buffer.alloc(8), gzipSync(JSON.stringify(message))])
    return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)
  }
  return { connect, pending, compressed, entered, release, messages }
}

test('worker preserves compressed presence and subsequent document message order', async () => {
  const h = harness(), socket = h.connect()
  socket.onmessage({ data: h.compressed({ type: 'roster', members: [] }) })
  socket.onmessage({ data: JSON.stringify({ type: 'update', update: 'committed' }) })
  await h.entered.promise
  assert.equal(h.messages.length, 0)
  h.release.resolve(); await h.pending()
  assert.deepEqual(h.messages.map(m => m.message.type), ['roster', 'update'])
})

test('closed connections cannot publish a snapshot or roster after asynchronous decoding', async () => {
  const h = harness(), old = h.connect()
  old.onmessage({ data: h.compressed({ type: 'roster', members: ['obsolete'] }) })
  const oldPending = h.pending(); await h.entered.promise
  old.onclose()
  const current = h.connect()
  current.onmessage({ data: JSON.stringify({ type: 'snapshot', update: 'fresh' }) })
  await h.pending(); h.release.resolve(); await oldPending
  assert.deepEqual(h.messages.map(m => m.type === 'message' ? m.message.update : m.type), ['disconnected', 'fresh'])
})

test('worker bounds asynchronous incoming queues and recovers through disconnect', async () => {
  const h = harness(), socket = h.connect()
  socket.onmessage({ data: h.compressed({ type: 'roster', members: [] }) })
  await h.entered.promise
  for (let i = 0; i < 64; i++) socket.onmessage({ data: JSON.stringify({ type: 'update', update: String(i) }) })
  assert.equal(socket.readyState, 3)
  h.release.resolve(); await h.pending()
  assert.deepEqual(h.messages.map(m => m.type), ['disconnected'])
})
