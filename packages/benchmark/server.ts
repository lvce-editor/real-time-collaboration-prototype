import { createServer } from 'node:http'
import type { Socket, AddressInfo } from 'node:net'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createCollaboration } from '@lvce-editor/real-time-collaboration/server'

const f = createCollaboration()
const server = createServer(f.request)
server.on('upgrade', f.upgrade)
const sockets = new Set<Socket>()
let written = 0, read = 0, peakRss = 0, peakHeap = 0
server.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => { written += socket.bytesWritten; read += socket.bytesRead; sockets.delete(socket) })
})
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable()
const startedCpu = process.cpuUsage()
function metrics() {
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed)
  return { serverPeakRssBytes: peakRss, serverPeakHeapBytes: peakHeap, serverCpuMs: (process.cpuUsage(startedCpu).user + process.cpuUsage(startedCpu).system) / 1000, serverEventLoopP95Ms: delay.percentile(95) / 1e6, serverEventLoopMaxMs: delay.max / 1e6, serverBytesSent: written + [...sockets].reduce((n, s) => n + s.bytesWritten, 0), serverBytesReceived: read + [...sockets].reduce((n, s) => n + s.bytesRead, 0), serverSockets: sockets.size }
}
await new Promise<void>(resolve => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
const host = f.create('Host', { 'benchmark.txt': '' })
const monitor = setInterval(() => process.send?.({ type: 'metrics', ...metrics() }), 1000)
let closing = false
async function close() {
  if (closing) return
  closing = true; clearInterval(monitor); delay.disable()
  await f.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  process.disconnect?.()
}
process.on('disconnect', () => { void close() })
process.on('message', (message: { type: string; start?: number; length?: number }) => {
  if (message.type === 'join') process.send?.({ type: 'joined', credentials: Array.from({ length: message.length! }, (_, j) => f.join(host.session, `User ${message.start! + j}`)) })
  if (message.type === 'summary') process.send?.({ type: 'summary', text: f.sessions.get(host.session)!.doc.getText('benchmark.txt').toString(), ...metrics() })
  if (message.type === 'close') void close()
})
process.send?.({ type: 'ready', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credentials: host })
