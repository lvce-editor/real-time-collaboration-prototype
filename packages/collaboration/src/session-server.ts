import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import * as Y from 'yjs'
import { fileURLToPath } from 'node:url'

type Role = 'host' | 'reader' | 'writer'
type Credentials = { session: string; token: string; id: string }
type RelativePositionJSON = ReturnType<typeof Y.relativePositionToJSON>
type CursorPosition = { anchor: RelativePositionJSON; head: RelativePositionJSON }
type ClientMessage =
  | { type: 'hello'; session: string; token: string }
  | { type: 'update'; update: string; sequence: number }
  | { type: 'request-write' }
  | { type: 'permission'; id: string; role: 'reader' | 'writer' }
  | { type: 'cursor'; file: string; cursor: CursorPosition }
  | { type: 'signal'; to: string; description: unknown }
  | { type: 'ping' }
type ServerMessage = Record<string, unknown> & { type: string }
type Participant = { id: string; token: string; name: string; role: Role; color: string; requested: boolean; socket?: WebSocket }
type Session = { id: string; doc: Y.Doc; files: string[]; members: Map<string, Participant>; touched: number; development?: boolean }
type CreateOptions = { idleMs?: number; maxMembers?: number; maxSessions?: number; development?: boolean }

declare module 'ws' {
  interface WebSocket { alive?: boolean }
}

export const encode = (data: Uint8Array): string => Buffer.from(data).toString('base64')
export const decode = (data: unknown): Uint8Array => {
  if (typeof data !== 'string' || data.length > 1_400_000) throw new Error('Invalid update')
  return new Uint8Array(Buffer.from(data, 'base64'))
}
// A permutation of 24-bit RGB values: no repeats within the participant limit.
const color = (index: number): string => '#' + ((0xd32f2f + index * 0x9e3779) % 0x1000000).toString(16).padStart(6, '0')
const publicMember = (p: Participant) => ({ id: p.id, name: p.name, role: p.role, color: p.color, online: !!p.socket, requested: p.requested })
const send = (socket: WebSocket | undefined, message: ServerMessage): void => {
  if (socket?.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > 2_000_000) return socket.close(1013, 'Slow consumer; reconnect for snapshot')
  socket.send(JSON.stringify(message))
}
export function createCollaboration({ idleMs = 30 * 60_000, maxMembers = 10_001, maxSessions = 100, development = false }: CreateOptions = {}) {
  const keys = generateKeyPairSync('ed25519')
  let developmentSession: string | undefined
  let peerSequence = 0
  const sessions = new Map<string, Session>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_400_000 })
  const broadcast = (session: Session, message: ServerMessage, except?: WebSocket): void => {
    for (const p of session.members.values()) if (p.socket !== except) send(p.socket, message)
  }
  const member = (session: Session, name: unknown, role: Role): Participant => {
    if (session.members.size >= maxMembers) throw new Error('Session participant limit reached')
    const p = { id: randomUUID(), token: randomUUID(), name: String(name || 'Guest').slice(0, 60), role, color: color(session.members.size), requested: false }
    session.members.set(p.token, p)
    session.touched = Date.now()
    return p
  }
  const credentials = (session: Session, p: Participant): Credentials => ({ session: session.id, token: p.token, id: p.id })
  const create = (name: unknown, files: Record<string, string> = { 'README.md': '# Shared project\n\nEdit together.\n', 'src/main.js': 'console.log("Hello collaborators")\n' }): Credentials => {
    if (sessions.size >= maxSessions) throw new Error('Server session limit reached')
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid project')
    const entries = Object.entries(files)
    if (!entries.length || entries.length > 100 || JSON.stringify(files).length > 500_000) throw new Error('Project limit: 100 text files / 500 kB')
    const doc = new Y.Doc()
    for (const [path, text] of entries) {
      if (!/^[\w. -]+(?:\/[\w. -]+)*$/.test(path) || path.split('/').some(x => x === '..' || x === '.') || path.length > 200 || typeof text !== 'string') throw new Error('Invalid text file')
      doc.getText(path).insert(0, text.replace(/\r\n?/g, '\n'))
    }
    const session: Session = { id: randomUUID(), doc, files: entries.map(([path]) => path), members: new Map(), touched: Date.now() }
    const host = member(session, name || 'Host', 'host')
    sessions.set(session.id, session)
    return credentials(session, host)
  }
  const join = (id: string, name: unknown): Credentials => {
    const session = sessions.get(id)
    if (!session) throw new Error('Session unavailable or expired')
    return credentials(session, member(session, name, 'reader'))
  }
  const joinDevelopment = (): Credentials => {
    if (!development) throw new Error('Development session disabled')
    if (!developmentSession || !sessions.has(developmentSession)) {
      const host = create('user-1')
      developmentSession = host.session
      sessions.get(host.session)!.development = true
      return host
    }
    const session = sessions.get(developmentSession)!
    return join(session.id, `user-${session.members.size + 1}`)
  }
  // Only authority-approved payloads may be relayed over untrusted peer channels.
  const relay = (session: Session, participant: Participant, message: ServerMessage): void => {
    if (!session.development) return
    const payload = JSON.stringify({ session: session.id, sender: participant.id, sequence: ++peerSequence, message })
    send(participant.socket, { type: 'peer-relay', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
  }
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.alive === false) socket.terminate()
      else { socket.alive = false; socket.ping() }
    }
  }, 30_000)
  heartbeat.unref()
  wss.on('connection', (socket) => {
    socket.alive = true
    socket.on('pong', () => { socket.alive = true })
    let session: Session | undefined, participant: Participant | undefined
    const timeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000)
    socket.on('error', () => {})
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage
        if (!participant) {
          if (message.type !== 'hello') throw new Error('Authenticate first')
          const authenticatedSession = message.session ? sessions.get(message.session) : undefined
          const authenticatedParticipant = authenticatedSession?.members.get(message.token ?? '')
          if (!authenticatedSession || !authenticatedParticipant) throw new Error('Invalid credentials')
          session = authenticatedSession
          participant = authenticatedParticipant
          if (!participant) throw new Error('Invalid credentials')
          clearTimeout(timeout)
          const previous = participant.socket
          participant.socket = socket
          previous?.close(1000, 'Connection replaced')
          session.touched = Date.now()
          send(socket, { type: 'snapshot', peerKey: session.development ? keys.publicKey.export({ format: 'jwk' }) : undefined, session: session.id, update: encode(Y.encodeStateAsUpdate(session.doc)), files: session.files, self: publicMember(participant), members: [...session.members.values()].filter(p => p.socket || p.role === 'host').map(publicMember) })
          broadcast(session, { type: 'member', member: publicMember(participant) }, socket)
          return
        }
        if (participant.socket !== socket) throw new Error('Connection replaced')
        if (!session) throw new Error('Session unavailable')
        session.touched = Date.now()
        switch (message.type) {
          case 'signal': {
            if (!session.development || JSON.stringify(message.description).length > 100_000) throw new Error('Invalid signaling')
            const target = [...session.members.values()].find(p => p.id === message.to && p !== participant)
            if (target?.socket) send(target.socket, { type: 'signal', from: participant.id, description: message.description })
            break
          }
          case 'update': {
            if (participant.role === 'reader') throw new Error('Write access required')
            const update = decode(message.update)
            // Validate against a clone: malformed updates never partially mutate authority.
            const probe = new Y.Doc()
            try {
              Y.applyUpdate(probe, Y.encodeStateAsUpdate(session.doc))
              Y.applyUpdate(probe, update)
              if (Y.encodeStateAsUpdate(probe).length > 2_000_000) throw new Error('Project state limit reached')
            } finally { probe.destroy() }
            Y.applyUpdate(session.doc, update)
            broadcast(session, { type: 'update', update: message.update }, socket)
            relay(session, participant, { type: 'update', update: message.update })
            send(socket, { type: 'ack', sequence: message.sequence })
            break
          }
          case 'request-write':
            if (participant.role === 'reader') {
              participant.requested = true
              broadcast(session, { type: 'member', member: publicMember(participant) })
            }
            break
          case 'permission': {
            if (participant.role !== 'host') throw new Error('Host approval required')
            const target = [...session.members.values()].find(p => p.id === message.id)
            if (!target || target.role === 'host' || (message.role !== 'reader' && message.role !== 'writer')) throw new Error('Invalid permission change')
            target.role = message.role
            target.requested = false
            broadcast(session, { type: 'member', member: publicMember(target) })
            break
          }
          case 'cursor': {
            if (typeof message.file !== 'string' || !session.files.includes(message.file) || JSON.stringify(message.cursor).length > 2000) throw new Error('Invalid cursor')
            const cursor = { type: 'cursor', id: participant.id, file: message.file, cursor: message.cursor, sequence: ++peerSequence }
            broadcast(session, cursor, socket)
            relay(session, participant, cursor)
            break
          }
          case 'ping': send(socket, { type: 'pong' }); break
          default: throw new Error('Unknown message')
        }
      } catch (error) {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : String(error) })
        // Force a fresh authoritative snapshot after rejected edits.
        if (participant) socket.close(1008, 'Rejected operation')
        else socket.close(1008, 'Authentication failed')
      }
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      if (participant?.socket !== socket || !session) return
      participant.socket = undefined
      session.touched = Date.now()
      broadcast(session, { type: 'member', member: publicMember(participant) })
    })
  })
  const sweep = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.touched > idleMs && ![...session.members.values()].some(p => p.socket)) {
        session.doc.destroy()
        sessions.delete(id)
      }
    }
  }, Math.min(idleMs, 60_000))
  sweep.unref()
  const assets: Record<string, [string, string]> = { '/syntaxHighlightingWorkerMain.js': ['syntaxHighlightingWorkerMain.js', 'text/javascript'], '/editorWorkerMain.js': ['editorWorkerMain.js', 'text/javascript'], '/native.css': ['native.css', 'text/css'], '/': ['index.html', 'text/html'], '/client.js': ['client.js', 'text/javascript'], '/transport-worker.js': ['transport-worker.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }
  const request = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Cache-Control', 'no-store')
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (req.method === 'POST' && ['/api/create', '/api/join', '/api/dev'].includes(path)) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new Error('Origin rejected')
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 600_000) throw new Error('Request too large')
        }
        const input = JSON.parse(body) as { name?: unknown; files?: Record<string, string>; session?: string }
        const result = path === '/api/dev' ? joinDevelopment() : path === '/api/create' ? create(input.name, input.files) : join(input.session ?? '', input.name)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      } else if (req.method === 'GET' && path === '/api/config') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ development }))
      } else if (req.method === 'GET' && assets[path]) {
        const [file, mime] = assets[path]
        res.setHeader('Content-Type', mime)
        res.end(await readFile(fileURLToPath(new URL(`../../../dist/${file}`, import.meta.url))))
      } else {
        res.statusCode = 404
        res.end('Not found')
      }
    } catch (error) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const origin = req.headers.origin
    if (req.url !== '/collaboration' || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  }
  const close = async () => {
    clearInterval(sweep)
    clearInterval(heartbeat)
    for (const socket of wss.clients) socket.terminate()
    await new Promise(resolve => wss.close(resolve))
    for (const session of sessions.values()) session.doc.destroy()
    sessions.clear()
  }
  return { request, upgrade, close, sessions, create, join }
}
