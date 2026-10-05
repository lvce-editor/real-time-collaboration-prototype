// Adapter contract: connect({url, credentials}), send(message), disconnect().
// Authority, signaling and recovery use this worker; WebRTC lives in peer-transport.ts.
type Credentials = { session: string; token: string; id: string }
type TransportMessage = { type: string; [key: string]: unknown }
type WorkerCommand = { type: 'connect'; url: string; credentials: Credentials } | { type: 'send'; message: TransportMessage } | { type: 'disconnect' }
class WebSocketTransport {
  socket: WebSocket | undefined
  heartbeat: ReturnType<typeof setInterval> | undefined
  lastMessage = 0
  incoming = Promise.resolve()
  connect({ url, credentials }: { url: string; credentials: Credentials }): void {
    this.disconnect()
    this.incoming = Promise.resolve()
    const socket = this.socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const queued = { count: 0, bytes: 0 }
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.lastMessage = Date.now()
      socket.send(JSON.stringify({ type: 'hello', ...credentials, presence: typeof DecompressionStream === 'function' ? 'batched' : undefined }))
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 6000) {
          this.disconnect(); postMessage({ type: 'disconnected' }); return
        }
        this.send({ type: 'ping' })
      }, 2000)
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      const bytes = typeof event.data === 'string' ? event.data.length : event.data.byteLength
      if (++queued.count > 64 || (queued.bytes += bytes) > 4_000_000) {
        this.disconnect(); postMessage({ type: 'disconnected' }); return
      }
      this.lastMessage = Date.now()
      this.incoming = this.incoming.then(async () => {
        if (this.socket !== socket) return
        let message
        if (typeof event.data === 'string') message = JSON.parse(event.data)
        else {
          // Eight-byte frame identity is for protocol load-generator caching;
          // browsers always decode their own complete presence payload.
          const stream = new Blob([event.data.slice(8)]).stream().pipeThrough(new DecompressionStream('gzip'))
          message = JSON.parse(await new Response(stream).text())
        }
        if (this.socket === socket) postMessage({ type: 'message', message })
      }).catch(() => { if (this.socket === socket) { this.disconnect(); postMessage({ type: 'disconnected' }) } }).finally(() => { queued.count--; queued.bytes -= bytes })
    }
    socket.onclose = () => { if (this.socket === socket) { this.socket = undefined; clearInterval(this.heartbeat); postMessage({ type: 'disconnected' }) } }
    socket.onerror = () => postMessage({ type: 'transport-error' })
  }
  send(message: TransportMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 2_000_000) this.socket.send(JSON.stringify(message))
    else { this.disconnect(); postMessage({ type: 'disconnected' }) }
  }
  disconnect(): void {
    clearInterval(this.heartbeat)
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }
}
const adapter = new WebSocketTransport()
onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  if (data.type === 'connect') adapter.connect(data)
  if (data.type === 'send') adapter.send(data.message)
  if (data.type === 'disconnect') adapter.disconnect()
}
