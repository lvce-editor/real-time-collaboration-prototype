import { gunzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createCollaboration, type CreateOptions, type Credentials } from '../src/session-server.ts'

type ProtocolMessage = {
  type: string
  cursors?: Array<{ id: string; file: string; cursor: unknown; sequence: number }>
  presencePending?: boolean
  members?: NonNullable<ProtocolMessage['member']>[]
  from?: string
  peerKey?: import('node:crypto').JsonWebKey
  payload?: string
  signature?: string
  id?: string
  update?: string
  sequence?: number
  message?: string
  self?: { id: string; role: string }
  member?: { id: string; name: string; role: string; online: boolean; requested: boolean }
  files?: string[]
}

export async function fixture(options: CreateOptions = {}) {
  const collaboration = createCollaboration(options)
  const server = createServer(collaboration.request)
  server.on('upgrade', collaboration.upgrade)
  await new Promise<void>(resolve => server.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address')
  const url = `http://127.0.0.1:${(address as AddressInfo).port}`
  const close = async () => {
    await collaboration.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  return { ...collaboration, url, close }
}
export async function client(base: string, credentials: Credentials, presence?: 'batched') {
  const socket = new WebSocket(base.replace('http', 'ws') + '/collaboration')
  const messages: ProtocolMessage[] = [], waiters = new Set<() => void>()
  socket.on('message', (raw, binary) => {
    const message = JSON.parse(binary ? gunzipSync((raw as Buffer).subarray(8)).toString() : raw.toString())
    messages.push(message as ProtocolMessage)
    for (const waiter of waiters) waiter()
  })
  socket.on('error', () => {})
  const wait = (predicate: string | ((message: ProtocolMessage) => boolean), timeout = 5000): Promise<ProtocolMessage> => {
    if (typeof predicate === 'string') { const type = predicate; predicate = m => m.type === type }
    return new Promise<ProtocolMessage>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Message timeout; received ${messages.map(x => x.type)}`)) }, timeout)
      const check = () => {
        const index = messages.findIndex(predicate as (message: ProtocolMessage) => boolean)
        if (index < 0) return
        clearTimeout(timer); waiters.delete(check); resolve(messages.splice(index, 1)[0])
      }
      waiters.add(check); check()
    })
  }
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message))
  send({ type: 'hello', ...credentials, presence })
  return { socket, send, wait, messages }
}
