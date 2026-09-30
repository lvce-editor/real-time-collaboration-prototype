import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import * as Y from 'yjs'

export const encode = (data) => Buffer.from(data).toString('base64')
export const decode = (data) => {
  if (typeof data !== 'string' || data.length > 1_400_000) throw new Error('Invalid update')
  return new Uint8Array(Buffer.from(data, 'base64'))
}
const colors = ['#d32f2f', '#1976d2', '#7b1fa2', '#00875a', '#b05b00', '#007c91']
const publicMember = (p) => ({ id: p.id, name: p.name, role: p.role, color: p.color, online: !!p.socket, requested: p.requested })
const send = (socket, message) => {
  if (socket?.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > 2_000_000) return socket.close(1013, 'Slow consumer; reconnect for snapshot')
  socket.send(JSON.stringify(message))
}
export function createCollaboration({ idleMs = 30 * 60_000, maxMembers = 10_001, maxSessions = 100 } = {}) {
  const sessions = new Map()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_400_000 })
  const broadcast = (session, message, except) => {
    for (const p of session.members.values()) if (p.socket !== except) send(p.socket, message)
  }
  const member = (session, name, role) => {
    if (session.members.size >= maxMembers) throw new Error('Session participant limit reached')
    const p = { id: randomUUID(), token: randomUUID(), name: String(name || 'Guest').slice(0, 60), role, color: colors[session.members.size % colors.length], requested: false }
    session.members.set(p.token, p)
    session.touched = Date.now()
    return p
  }
  const credentials = (session, p) => ({ session: session.id, token: p.token, id: p.id })
  const create = (name, files = { 'README.md': '# Shared project\n\nEdit together.\n', 'src/main.js': 'console.log("Hello collaborators")\n' }) => {
    if (sessions.size >= maxSessions) throw new Error('Server session limit reached')
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid project')
    const entries = Object.entries(files)
    if (!entries.length || entries.length > 100 || JSON.stringify(files).length > 500_000) throw new Error('Project limit: 100 text files / 500 kB')
    const doc = new Y.Doc()
    for (const [path, text] of entries) {
      if (!/^[\w. -]+(?:\/[\w. -]+)*$/.test(path) || path.split('/').some(x => x === '..' || x === '.') || path.length > 200 || typeof text !== 'string') throw new Error('Invalid text file')
      doc.getText(path).insert(0, text)
    }
    const session = { id: randomUUID(), doc, files: entries.map(([path]) => path), members: new Map(), touched: Date.now() }
    const host = member(session, name || 'Host', 'host')
    sessions.set(session.id, session)
    return credentials(session, host)
  }
  const join = (id, name) => {
    const session = sessions.get(id)
    if (!session) throw new Error('Session unavailable or expired')
    return credentials(session, member(session, name, 'reader'))
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
    let session, participant
    const timeout = setTimeout(() => socket.close(1008, 'Authentication timeout'), 5000)
    socket.on('error', () => {})
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString())
        if (!participant) {
          if (message.type !== 'hello') throw new Error('Authenticate first')
          session = sessions.get(message.session)
          participant = session?.members.get(message.token)
          if (!participant) throw new Error('Invalid credentials')
          clearTimeout(timeout)
          const previous = participant.socket
          participant.socket = socket
          previous?.close(1000, 'Connection replaced')
          session.touched = Date.now()
          send(socket, { type: 'snapshot', update: encode(Y.encodeStateAsUpdate(session.doc)), files: session.files, self: publicMember(participant), members: [...session.members.values()].filter(p => p.socket || p.role === 'host').map(publicMember) })
          broadcast(session, { type: 'member', member: publicMember(participant) }, socket)
          return
        }
        if (participant.socket !== socket) throw new Error('Connection replaced')
        session.touched = Date.now()
        switch (message.type) {
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
            if (!target || target.role === 'host' || !['reader', 'writer'].includes(message.role)) throw new Error('Invalid permission change')
            target.role = message.role
            target.requested = false
            broadcast(session, { type: 'member', member: publicMember(target) })
            break
          }
          case 'cursor':
            if (!session.files.includes(message.file) || JSON.stringify(message.cursor).length > 2000) throw new Error('Invalid cursor')
            broadcast(session, { type: 'cursor', id: participant.id, file: message.file, cursor: message.cursor }, socket)
            break
          case 'ping': send(socket, { type: 'pong' }); break
          default: throw new Error('Unknown message')
        }
      } catch (error) {
        send(socket, { type: 'error', message: error.message })
        // Force a fresh authoritative snapshot after rejected edits.
        if (participant) socket.close(1008, 'Rejected operation')
        else socket.close(1008, 'Authentication failed')
      }
    })
    socket.on('close', () => {
      clearTimeout(timeout)
      if (participant?.socket !== socket) return
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
  const assets = { '/': ['index.html', 'text/html'], '/client.js': ['client.js', 'text/javascript'], '/transport-worker.js': ['transport-worker.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }
  const request = async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Cache-Control', 'no-store')
      const path = new URL(req.url, 'http://localhost').pathname
      if (req.method === 'POST' && ['/api/create', '/api/join'].includes(path)) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw new Error('Origin rejected')
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 600_000) throw new Error('Request too large')
        }
        const input = JSON.parse(body)
        const result = path === '/api/create' ? create(input.name, input.files) : join(input.session, input.name)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      } else if (req.method === 'GET' && assets[path]) {
        const [file, mime] = assets[path]
        res.setHeader('Content-Type', mime)
        res.end(await readFile(new URL(`../dist/${file}`, import.meta.url)))
      } else {
        res.statusCode = 404
        res.end('Not found')
      }
    } catch (error) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: error.message }))
    }
  }
  const upgrade = (req, socket, head) => {
    const origin = req.headers.origin
    if (req.url !== '/collaboration' || (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`)) return socket.destroy()
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
