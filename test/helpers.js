import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createCollaboration } from '../src/session-server.js'

export async function fixture(options) {
  const collaboration = createCollaboration(options)
  const server = createServer(collaboration.request)
  server.on('upgrade', collaboration.upgrade)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const close = async () => { await collaboration.close(); await new Promise(resolve => server.close(resolve)) }
  return { ...collaboration, url, close }
}
export async function client(base, credentials) {
  const socket = new WebSocket(base.replace('http', 'ws') + '/collaboration')
  const messages = [], waiters = new Set()
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message)
    for (const waiter of waiters) waiter()
  })
  socket.on('error', () => {})
  const wait = (predicate, timeout = 5000) => {
    if (typeof predicate === 'string') { const type = predicate; predicate = m => m.type === type }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Message timeout; received ${messages.map(x => x.type)}`)) }, timeout)
      const check = () => {
        const index = messages.findIndex(predicate)
        if (index < 0) return
        clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0])
      }
      waiters.add(check); check()
    })
  }
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = message => socket.send(JSON.stringify(message))
  send({ type: 'hello', ...credentials })
  return { socket, send, wait, messages }
}
