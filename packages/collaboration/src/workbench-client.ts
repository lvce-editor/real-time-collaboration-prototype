import * as Y from 'yjs'
import { PeerTransport } from './peer-transport.ts'
import { applyLocalText, offsetAt, positionAt, relativeSelections, resolveSelections } from './native/binding.ts'

// The real workbench owns editors, keyboard input, Explorer and Output. These
// commands are installed by the version-checked build-time workbench patch.
const runtimeUrl = '/56b33a7/packages/renderer-process/dist/rendererProcessMain.js'
const runtime = await import(runtimeUrl)
await runtime.ready
await new Promise<void>(resolve => {
  if (document.querySelector('.Main')) { resolve(); return }
  const observer = new MutationObserver(() => {
    if (document.querySelector('.Main')) { observer.disconnect(); resolve() }
  })
  observer.observe(document.body, { childList: true, subtree: true })
})
const invoke = runtime.executeCommand as (method: string, ...args: any[]) => Promise<any>
type Credentials = { session: string; token: string; id: string }
type Member = { id: string; name: string; role: 'host' | 'writer' | 'reader'; color: string; online: boolean; requested: boolean }
type Editor = { uid: number; uri: string; x: number; y: number; width: number; height: number }
type NativeState = { text: string; selections: number[]; rowHeight: number; charWidth: number; deltaX: number; deltaY: number }
type Cursor = { sequence: number; id: string; file: string; cursor: { anchor: ReturnType<typeof Y.relativePositionToJSON>; head: ReturnType<typeof Y.relativePositionToJSON> } }
const root = 'memfs:///collaboration/'
const worker = new Worker('/transport-worker.js', { type: 'module' })
const decode = (data: string) => Uint8Array.from(atob(data), c => c.charCodeAt(0))
const encode = (data: Uint8Array) => { let s = ''; for (const b of data) s += String.fromCharCode(b); return btoa(s) }
let credentials: Credentials | undefined, doc: Y.Doc | undefined, self: Member | undefined, connected = false, sequence = 0, reconnectTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let files: string[] = [], currentFile = '', logLevel = localStorage.getItem('collaboration.logLevel') || 'info'
const members = new Map<string, Member>(), cursors = new Map<string, Cursor>(), pending = new Set<number>()
const lines: string[] = []
let tail = Promise.resolve()
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation)
  tail = result.then(() => {}, error => { console.error(error); log('info', 'Collaboration error', String(error)) })
  return result
}
function log(level: string, event: string, detail?: unknown) {
  const levels: Record<string, number> = { off: 0, info: 1, debug: 2, trace: 3 }
  if (levels[level] > levels[logLevel]) return
  lines.push(`${new Date().toISOString()} [${level}] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`)
  if (lines.length > 300) lines.shift()
  void invoke('Collaboration.log', lines.join('\n')).catch(console.error)
}
function send(message: any) { if (connected) { log('trace', `send ${message.type}`, message.type === 'update' ? { bytes: message.update.length, sequence: message.sequence } : message); worker.postMessage({ type: 'send', message }) } }
function connect() {
  clearTimeout(reconnectTimer)
  worker.postMessage({ type: 'connect', url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/collaboration`, credentials })
}
const canWrite = () => connected && (self?.role === 'host' || self?.role === 'writer')
const editorFile = (editor: Editor) => editor.uri.slice(root.length)
async function editors(): Promise<Editor[]> { return invoke('Collaboration.editors') }
async function state(editor: Editor): Promise<NativeState> { return invoke('Collaboration.state', editor.uid) }
async function capture() {
  const result: { editor: Editor; positions: Y.RelativePosition[] }[] = []
  for (const editor of await editors()) {
    const text = doc?.getText(editorFile(editor))
    if (text) result.push({ editor, positions: relativeSelections(text, (await state(editor)).selections) })
  }
  return result
}
async function sync(captured: Awaited<ReturnType<typeof capture>>) {
  if (!doc) return
  for (const file of files) await invoke('Collaboration.writeFile', file, doc.getText(file).toString())
  const live = new Set((await editors()).map(e => e.uid))
  for (const { editor, positions } of captured) {
    const text = doc.getText(editorFile(editor))
    if (live.has(editor.uid)) await invoke('Collaboration.snapshot', editor, text.toString(), resolveSelections(text, positions))
  }
  await presence()
}
function inputPermissions() {
  for (const input of document.querySelectorAll<HTMLTextAreaElement>('.Editor textarea')) input.readOnly = !canWrite()
  document.body.dataset.collaborationConnected = String(connected)
  document.body.dataset.collaborationReadonly = String(!canWrite())
}
function publishCursor(file: string, native: NativeState) {
  const text = doc?.getText(file)
  if (!text || !connected) return
  send({ type: 'cursor', file, cursor: {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offsetAt(native.text, native.selections[0], native.selections[1]))),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offsetAt(native.text, native.selections[2], native.selections[3]))),
  } })
}
async function publishActiveCursor() {
  const editor = (await editors()).find(editor => editorFile(editor) === currentFile)
  if (editor) publishCursor(currentFile, await state(editor))
}
const overlays = new Map<number, HTMLElement>()
function textBoundary(row: HTMLElement, column: number): number | undefined {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  if (!node && column === 0) return row.getBoundingClientRect().left
  let remaining = column
  while (node) {
    const length = node.data.length
    if (remaining <= length) {
      const offset = remaining
      if (offset === 0) {
        if (!length) return row.getBoundingClientRect().left
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1)
        return range.getBoundingClientRect().left
      }
      const range = document.createRange(); range.setStart(node, offset - 1); range.setEnd(node, offset)
      return range.getBoundingClientRect().right
    }
    remaining -= length
    node = walker.nextNode() as Text | null
  }
  return undefined
}
function renderedRow(rows: HTMLElement, line: string, top: number): HTMLElement | undefined {
  let closest: HTMLElement | undefined, distance = Infinity
  for (const candidate of rows.querySelectorAll<HTMLElement>('.EditorRow')) {
    if (candidate.textContent !== line) continue
    const candidateDistance = Math.abs(candidate.getBoundingClientRect().top - top)
    if (candidateDistance < distance) { closest = candidate; distance = candidateDistance }
  }
  return closest
}
async function presence() {
  const live = await editors()
  for (const [uid, overlay] of overlays) {
    if (!live.some(e => e.uid === uid)) { overlay.remove(); overlays.delete(uid) }
  }
  for (const editor of live) {
    const file = editorFile(editor), text = doc?.getText(file)
    if (!text) continue
    const native = await state(editor)
    let overlay = overlays.get(editor.uid)
    if (!overlay) { overlay = document.createElement('div'); overlay.className = 'collaboration-presence'; document.body.append(overlay); overlays.set(editor.uid, overlay) }
    Object.assign(overlay.style, { left: `${editor.x}px`, top: `${editor.y}px`, width: `${editor.width}px`, height: `${editor.height}px` })
    overlay.replaceChildren()
    for (const [id, cursor] of cursors) {
      const member = members.get(id)
      if (cursor.file !== file || !member?.online) continue
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.cursor.head), doc!)
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.cursor.anchor), doc!)
      if (!head || head.type !== text) continue
      const [row, col] = positionAt(native.text, head.index)
      const caret = document.createElement('div'); caret.className = 'remote-cursor'; caret.dataset.participant = id
      // LVCE's native content starts after the line-number gutter.
      const element = document.querySelector(`[data-uid="${editor.uid}"]`) ?? document.querySelector('.Editor')
      const rows = element?.querySelector('.EditorRows') as HTMLElement | null
      const gutter = rows ? rows.getBoundingClientRect().left - editor.x : 50
      const lines = native.text.split('\n')
      const rendered = rows && renderedRow(rows, lines[row] ?? '', editor.y + row * native.rowHeight - native.deltaY)
      const measuredX = rendered && textBoundary(rendered, col)
      const caretLeft = measuredX == null ? gutter + col * native.charWidth - native.deltaX : measuredX - editor.x
      const caretTop = rendered ? rendered.getBoundingClientRect().top - editor.y : row * native.rowHeight - native.deltaY
      const caretHeight = rendered?.getBoundingClientRect().height ?? native.rowHeight
      Object.assign(caret.style, { left: `${caretLeft}px`, top: `${caretTop}px`, height: `${caretHeight}px`, borderColor: member.color })
      const label = document.createElement('span'); label.className = 'remote-cursor-label'; label.style.backgroundColor = member.color
      const avatar = document.createElement('span'); avatar.className = 'collaboration-avatar'; avatar.textContent = member.name.slice(0, 1).toUpperCase(); avatar.setAttribute('aria-hidden', 'true')
      label.append(avatar, document.createTextNode(member.name)); caret.append(label); overlay.append(caret)
      if (anchor?.type === text && anchor.index !== head.index) {
        const start = Math.min(anchor.index, head.index), end = Math.max(anchor.index, head.index)
        const [firstRow, firstCol] = positionAt(native.text, start), [lastRow, lastCol] = positionAt(native.text, end)
        const rowsText = native.text.split('\n')
        for (let r = firstRow; r <= lastRow; r++) {
          const a = r === firstRow ? firstCol : 0, b = r === lastRow ? lastCol : rowsText[r].length
          const selection = document.createElement('div'); selection.className = 'remote-selection'
          const selectionRow = rows && renderedRow(rows, rowsText[r], editor.y + r * native.rowHeight - native.deltaY)
          const measuredStart = selectionRow && textBoundary(selectionRow, a)
          const measuredEnd = selectionRow && textBoundary(selectionRow, b)
          const left = measuredStart == null ? gutter + a * native.charWidth - native.deltaX : measuredStart - editor.x
          const width = measuredStart == null || measuredEnd == null ? (b - a) * native.charWidth : measuredEnd - measuredStart
          const top = selectionRow ? selectionRow.getBoundingClientRect().top - editor.y : r * native.rowHeight - native.deltaY
          const height = selectionRow?.getBoundingClientRect().height ?? native.rowHeight
          Object.assign(selection.style, { backgroundColor: member.color, left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }); overlay.append(selection)
        }
      }
    }
  }
  inputPermissions()
}
const peers = new PeerTransport(message => worker.postMessage({ type: 'send', message }), (message, isCurrent) => handleTransport({ type: 'message', message }, isCurrent), event => log('debug', event))
function handleTransport(data: any, isCurrent = () => true) {
  void enqueue(async () => {
    if (!isCurrent()) return
    if (data.type === 'disconnected') { connected = false; peers.reset(); inputPermissions(); log('info', 'Disconnected; editing paused'); if (credentials) reconnectTimer = setTimeout(connect, 1500); return }
    if (data.type === 'transport-error') { log('info', 'Transport error'); return }
    const message = data.message
    if (!message) return
    if (message.type === 'signal') { peers.accept(message.from, message.description); return }
    if (message.type === 'peer-relay') { peers.relay(message); return }
    log('trace', `receive ${message.type}`, message.type === 'update' || message.type === 'snapshot' ? { bytes: message.update.length } : message)
    switch (message.type) {
      case 'snapshot': {
        const epoch = ++generation
        connected = false; inputPermissions()
        doc?.destroy(); doc = new Y.Doc(); Y.applyUpdate(doc, decode(message.update))
        if (pending.size) log('info', 'Reconnected to authority; unacknowledged edits may have been discarded', { count: pending.size })
        pending.clear(); cursors.clear(); self = message.self; files = message.files; members.clear()
        for (const member of message.members) members.set(member.id, member)
        for (const cursor of message.cursors) cursors.set(cursor.id, cursor)
        // Signaling can arrive while the workbench opens its native editor.
        // Establish peers before releasing this snapshot's queue position.
        peers.reset(message)
        const project = Object.fromEntries(files.map(file => [file, doc!.getText(file).toString()]))
        await invoke('Collaboration.workspace', project)
        doc.on('update', (update, origin) => { if (origin !== 'remote') { const id = ++sequence; pending.add(id); send({ type: 'update', update: encode(update), sequence: id }) } })
        currentFile = files.includes(currentFile) ? currentFile : files[0]
        // Opening a workbench editor can dispatch focus/input callbacks. Release
        // this queue before waiting on that lifecycle, then reconcile authority.
        void invoke('Collaboration.openFile', root + currentFile).then(() => enqueue(async () => {
          if (epoch !== generation || !credentials) return
          connected = true
          await sync(await capture()); await publishActiveCursor(); log('info', 'Joined collaboration', { role: self?.role, files: files.length })
        })).catch(console.error)
        break
      }
      case 'update': { const positions = await capture(); if (doc) Y.applyUpdate(doc, decode(message.update), 'remote'); await sync(positions); break }
      case 'ack': pending.delete(message.sequence); break
      case 'roster':
        members.clear()
        for (const cursor of message.cursors) cursors.set(cursor.id, cursor)
        // The roster follows its snapshot on the same ordered WebSocket.
      case 'members':
      case 'member': {
        const changes: Member[] = message.type !== 'member' ? message.members : [message.member]
        for (const member of changes) {
          if (members.get(member.id)?.online !== member.online) peers.member(member)
          members.set(member.id, member)
          if (!member.online) cursors.delete(member.id)
          if (member.id === self?.id) self = member
        }
        await presence(); log('info', 'Participants changed', { count: changes.length }); break
      }
      case 'cursor':
        if (message.sequence > (cursors.get(message.id)?.sequence ?? -1)) { cursors.set(message.id, message); await presence() } break
      case 'error':
        log('info', 'Server rejected operation', { reason: message.message })
        if (message.message === 'Invalid credentials') { connected = false; credentials = undefined; sessionStorage.removeItem('collaboration.credentials'); inputPermissions() }
        else if (pending.size) { connected = false; inputPermissions(); connect() }
    }
  })
}
worker.onmessage = event => handleTransport(event.data)
async function enter(path: string, data: Record<string, unknown>) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  credentials = result
  if (!development) sessionStorage.setItem('collaboration.credentials', JSON.stringify(credentials))
  connect()
}
async function importProject() {
  const input = document.createElement('input'); input.type = 'file'; input.webkitdirectory = true; input.multiple = true
  const selected = await new Promise<File[]>((resolve) => { input.onchange = () => resolve(Array.from(input.files ?? [])); input.oncancel = () => resolve([]); input.click() })
  if (!selected.length) return undefined
  if (selected.length > 100 || selected.reduce((n, f) => n + f.size, 0) > 500_000) throw new Error('Project limit: 100 text files / 500 kB')
  return Object.fromEntries(await Promise.all(selected.map(async file => { const text = await file.text(); if (text.includes('\0')) throw new Error('Only text files are supported'); return [file.webkitRelativePath.split('/').slice(1).join('/'), text] })))
}
async function action(id?: string, args: any = {}) {
  if (!id) {
    const choices = !credentials ? ['Host project', 'Host folder', 'Join project'] : ['Participants', 'Copy invitation', 'Request write access', 'Download file', 'Log verbosity', 'Show Output', 'Leave']
    const choice = await invoke('Collaboration.pick', choices.map(label => ({ label })))
    if (!choice) return
    id = typeof choice === 'string' ? choice : choice.label
  }
  switch (id) {
    case 'Host project': case 'Host folder': case 'Join project': {
      const name = args.name ?? await invoke('Collaboration.input', { placeholder: 'Your name', value: 'Collaborator' })
      if (!name) return
      if (id === 'Join project') {
        const session = args.session ?? (location.hash.slice(1) || await invoke('Collaboration.input', { placeholder: 'Invitation UUID' }))
        if (session) await enter('/api/join', { name, session })
      } else await enter('/api/create', { name, files: args.files ?? (id === 'Host folder' ? await importProject() : undefined) })
      break
    }
    case 'Participants': {
      const picks = [...members.values()].map(m => ({ label: `${m.name} · ${m.role}${m.online ? '' : ' · offline'}${m.requested ? ' · requests write access' : ''}`, id: m.id }))
      const selected = await invoke('Collaboration.pick', picks)
      if (self?.role === 'host' && selected?.id && selected.id !== self.id) { const member = members.get(selected.id)!; send({ type: 'permission', id: member.id, role: member.role === 'writer' ? 'reader' : 'writer' }) }
      break
    }
    case 'Permission': if (self?.role === 'host') send({ type: 'permission', id: args.id, role: args.role }); break
    case 'Request write access': send({ type: 'request-write' }); break
    case 'Copy invitation': if (credentials) await navigator.clipboard.writeText(`${location.origin}/#${credentials.session}`); break
    case 'Log verbosity': {
      const selected = args.level ?? await invoke('Collaboration.pick', ['off', 'info', 'debug', 'trace'].map(label => ({ label })))
      if (selected) { logLevel = typeof selected === 'string' ? selected : selected.label; localStorage.setItem('collaboration.logLevel', logLevel) } break
    }
    case 'Clear output': lines.length = 0; await invoke('Collaboration.log', ''); break
    case 'Show Output': await invoke('Collaboration.output'); break
    case 'Download file': {
      if (!doc || !currentFile) return
      const url = URL.createObjectURL(new Blob([doc.getText(currentFile).toString()], { type: 'text/plain' }))
      const link = document.createElement('a'); link.href = url; link.download = currentFile.split('/').at(-1)!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); break
    }
    case 'Leave': generation++; credentials = undefined; connected = false; clearTimeout(reconnectTimer); peers.reset(); worker.postMessage({ type: 'disconnect' }); doc?.destroy(); doc = undefined; sessionStorage.removeItem('collaboration.credentials'); cursors.clear(); await invoke('Collaboration.closeEditors'); for (const overlay of overlays.values()) overlay.remove(); overlays.clear(); inputPermissions(); break
    default: throw new Error(`Unknown collaboration action: ${id}`)
  }
}
const bridge = {
  action,
  localUid: async (uid: number, command: string, ...args: unknown[]) => {
    const editor = (await editors()).find(e => e.uid === uid)
    if (editor) return bridge.local(editor, command.includes('.') ? command : `Editor.${command}`, args, false)
  },
  local: (editor: Editor, command: string, args: unknown[], preserveFocus: boolean) => enqueue(async () => {
    if (!(await editors()).some(e => e.uid === editor.uid)) return { ...editor, commands: [] }
    const file = editorFile(editor), text = doc?.getText(file)
    const before = await state(editor)
    const navigation = /\.(cursor|select|handle(Mouse|Pointer|ScrollBar)|handleWheel|handleFocus|handleBlur|handleKeyUp|resize)/.test(command)
    if (!text || (!canWrite() && !navigation)) return invoke('Collaboration.raw', editor, 'Editor.handleBlur', [], true)
    const result = await invoke('Collaboration.raw', editor, command, args, preserveFocus)
    const after = await state(editor)
    if (!canWrite() && after.text !== before.text) await invoke('Collaboration.snapshot', editor, text.toString(), before.selections)
    else applyLocalText(text, before.text, after.text)
    currentFile = file; publishCursor(file, after); await presence(); return result
  }),
  snapshot: () => ({ connected, self, members: [...members.values()], invitation: credentials ? `${location.origin}/#${credentials.session}` : '', files, currentFile, texts: Object.fromEntries(files.map(f => [f, doc?.getText(f).toString()])), log: lines.join('\n'), pending: pending.size }),
}
Object.assign(globalThis, { lvceCollaboration: bridge })
// Initial content loading and focus during workbench layout do not enter the
// collaboration command queue. Native user input and incoming updates do.
const observer = new MutationObserver(inputPermissions)
observer.observe(document.body, { subtree: true, childList: true })
const { development } = await fetch('/api/config').then(r => r.json())
await invoke('Collaboration.log', '')
if (development) await enter('/api/dev', {})
else {
  try {
    const saved = JSON.parse(sessionStorage.getItem('collaboration.credentials') ?? 'null')
    if (saved && typeof saved.session === 'string' && typeof saved.token === 'string' && typeof saved.id === 'string' && (!location.hash || saved.session === location.hash.slice(1))) { credentials = saved; connect() }
  } catch { sessionStorage.removeItem('collaboration.credentials') }
}
window.addEventListener('beforeunload', () => { clearTimeout(reconnectTimer); peers.reset(); observer.disconnect(); worker.terminate(); doc?.destroy() })
