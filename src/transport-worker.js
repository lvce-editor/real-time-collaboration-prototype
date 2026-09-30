// Adapter contract: connect({url, credentials}), send(message), disconnect().
// A WebRTC/WebTransport adapter can implement this without changing CRDT/UI code.
class WebSocketTransport {
  socket
  heartbeat
  lastMessage = 0
  connect({ url, credentials }) {
    this.disconnect()
    const socket = this.socket = new WebSocket(url)
    socket.onopen = () => {
      this.lastMessage = Date.now()
      socket.send(JSON.stringify({ type: 'hello', ...credentials }))
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 6000) {
          this.disconnect(); postMessage({ type: 'disconnected' }); return
        }
        this.send({ type: 'ping' })
      }, 2000)
    }
    socket.onmessage = event => { this.lastMessage = Date.now(); postMessage({ type: 'message', message: JSON.parse(event.data) }) }
    socket.onclose = () => { if (this.socket === socket) { clearInterval(this.heartbeat); postMessage({ type: 'disconnected' }) } }
    socket.onerror = () => postMessage({ type: 'transport-error' })
  }
  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 2_000_000) this.socket.send(JSON.stringify(message))
    else { this.disconnect(); postMessage({ type: 'disconnected' }) }
  }
  disconnect() {
    clearInterval(this.heartbeat)
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }
}
const adapter = new WebSocketTransport()
onmessage = ({ data }) => {
  if (data.type === 'connect') adapter.connect(data)
  if (data.type === 'send') adapter.send(data.message)
  if (data.type === 'disconnect') adapter.disconnect()
}
