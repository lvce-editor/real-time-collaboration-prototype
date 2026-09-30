import * as Y from 'yjs'
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state'
import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'

type UiElement = HTMLElement & { value: string; disabled: boolean; files: FileList | null; onclick: ((event: MouseEvent) => void) | null; onchange: ((event: Event) => void) | null; scrollTop: number }
const $ = (id: string): UiElement => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing page element: ${id}`)
  return element as UiElement
}
const worker = new Worker('/transport-worker.js', { type: 'module' })
const decode = (data: string): Uint8Array => Uint8Array.from(atob(data), c => c.charCodeAt(0))
// Chunk encoding avoids overflowing the argument stack for project snapshots.
const encodeUpdate = (data: Uint8Array): string => { let s = ''; for (const byte of data) s += String.fromCharCode(byte); return btoa(s) }
type Credentials = { session: string; token: string; id: string }
type Role = 'host' | 'reader' | 'writer'
type Member = { id: string; name: string; role: Role; color: string; online: boolean; requested: boolean }
type RelativePositionJSON = ReturnType<typeof Y.relativePositionToJSON>
type Cursor = { anchor: RelativePositionJSON; head: RelativePositionJSON }
type WireMessage =
  | { type: 'snapshot'; update: string; files: string[]; self: Member; members: Member[] }
  | { type: 'update'; update: string }
  | { type: 'ack'; sequence: number }
  | { type: 'member'; member: Member }
  | { type: 'cursor'; id: string; file: string; cursor: Cursor }
  | { type: 'error'; message: string }
  | { type: 'pong' }
type ClientMessage = { type: 'update'; update: string; sequence: number } | { type: 'permission'; id: string; role: 'reader' | 'writer' } | { type: 'cursor'; file: string; cursor: Cursor } | { type: 'request-write' }
let credentials: Credentials | undefined, doc: Y.Doc | undefined, view: EditorView | undefined, self: Member | undefined, files: string[] = [], currentFile: string | undefined, connected = false, reconnectTimer: ReturnType<typeof setTimeout> | undefined, sequence = 0
const members = new Map<string, Member>(), cursors = new Map<string, Extract<WireMessage, { type: 'cursor' }>>(), pending = new Set<number>()
const editable = new Compartment()
const cursorEffect = StateEffect.define<ReturnType<typeof Decoration.set>>()
const cursorField = StateField.define<ReturnType<typeof Decoration.set>>({ create: () => Decoration.none, update: (value, transaction) => {
  value = value.map(transaction.changes)
  for (const effect of transaction.effects) if (effect.is(cursorEffect)) value = effect.value
  return value
}, provide: field => EditorView.decorations.from(field) })
class CursorWidget extends WidgetType {
  member: Member
  constructor(member: Member) { super(); this.member = member }
  toDOM() {
    const cursor = document.createElement('span')
    cursor.className = 'remote-cursor'
    cursor.style.borderColor = this.member.color
    cursor.dataset.participant = this.member.id
    const label = cursor.appendChild(document.createElement('span'))
    label.className = 'remote-cursor-label'
    label.style.background = this.member.color
    label.textContent = this.member.name
    return cursor
  }
}
const levels: Record<string, number> = { off: 0, info: 1, debug: 2, trace: 3 }
$('verbosity').value = localStorage.getItem('collaboration.logLevel') || 'info'
function log(level: keyof typeof levels, event: string, detail?: unknown) {
  if (levels[level] > levels[$('verbosity').value]) return
  const line = `${new Date().toISOString()} [${level}] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`
  $('output').textContent = ($('output').textContent + line).split('\n').slice(-300).join('\n')
  $('output').scrollTop = $('output').scrollHeight
}
$('verbosity').onchange = () => { localStorage.setItem('collaboration.logLevel', $('verbosity').value); log('info', 'Log verbosity changed') }
$('clear').onclick = () => { $('output').textContent = '' }
function send(message: ClientMessage) {
  if (!connected) return
  log('trace', `send ${message.type}`, message.type === 'update' ? { bytes: message.update.length, sequence: message.sequence } : message)
  worker.postMessage({ type: 'send', message })
}
function connect(): void {
  clearTimeout(reconnectTimer)
  $('connection').textContent = 'Connecting…'
  worker.postMessage({ type: 'connect', url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/collaboration`, credentials })
}
function updatePermission() {
  const canWrite = connected && self?.role !== 'reader'
  if (view) view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(canWrite), EditorState.readOnly.of(!canWrite)]) })
  $('permission').textContent = !connected ? 'Disconnected · read-only' : self?.role === 'reader' ? 'Read-only' : 'Write access'
  $('request').hidden = self?.role !== 'reader'
  $('request').disabled = !connected || !!self?.requested
}
function renderMembers() {
  $('members').replaceChildren()
  for (const member of members.values()) {
    const row = document.createElement('div')
    row.className = 'member'
    row.style.borderLeft = `3px solid ${member.color}`
    const text = document.createElement('span')
    text.textContent = `${member.name} · ${member.role}${member.online ? '' : ' · offline'}${member.requested ? ' · requests write access' : ''}`
    row.append(text)
    if (self?.role === 'host' && member.id !== self.id) {
      const button = document.createElement('button')
      button.textContent = member.role === 'writer' ? `Revoke ${member.name}` : `Allow ${member.name}`
      button.onclick = () => send({ type: 'permission', id: member.id, role: member.role === 'writer' ? 'reader' : 'writer' })
      row.append(button)
    }
    $('members').append(row)
  }
}
function renderCursors() {
  if (!view || !doc) return
  const decorations = []
  for (const [id, item] of cursors) {
    const member = members.get(id)
    if (item.file !== currentFile || !member?.online) continue
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(item.cursor.head), doc)
      const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(item.cursor.anchor), doc)
      if (!pos || pos.type !== doc.getText(currentFile) || pos.index > view.state.doc.length) continue
      decorations.push(Decoration.widget({ widget: new CursorWidget(member), side: 1 }).range(pos.index))
      if (anchor?.type === pos.type && anchor.index !== pos.index && anchor.index <= view.state.doc.length) decorations.push(Decoration.mark({ attributes: { style: `background:${member.color}44` } }).range(Math.min(anchor.index, pos.index), Math.max(anchor.index, pos.index)))
    } catch { /* Stale/unresolvable presence is ephemeral, never document data. */ }
  }
  view.dispatch({ effects: cursorEffect.of(Decoration.set(decorations, true)) })
}
function publishCursor() {
  if (!view || !doc || !connected) return
  const { anchor, head } = view.state.selection.main
  const text = doc.getText(currentFile ?? '')
  send({ type: 'cursor', file: currentFile!, cursor: { anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, anchor)), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, head)) } })
}
function openFile(file: string) {
  view?.destroy()
  currentFile = file
  $('filename').textContent = file
  const text = doc!.getText(file)
  view = new EditorView({ parent: $('editor'), state: EditorState.create({ doc: text.toString(), extensions: [
    basicSetup, yCollab(text, undefined), cursorField,
    editable.of([]),
    EditorView.theme({ '&': { color: '#e4e9ef', backgroundColor: '#171b20' }, '.cm-content': { caretColor: '#fff' }, '.cm-gutters': { backgroundColor: '#20262e', color: '#8e9dad', border: 'none' } }, { dark: true }),
    EditorView.updateListener.of(update => { if (update.selectionSet || update.docChanged) queueMicrotask(publishCursor) }),
  ] }) })
  updatePermission()
  renderCursors()
  publishCursor()
  log('debug', 'Opened file', { file })
}
worker.onmessage = ({ data }: MessageEvent<{ type: 'disconnected' | 'transport-error' } | { type: 'message'; message: WireMessage }>) => {
  if (data.type === 'disconnected') {
    connected = false
    $('connection').textContent = 'Disconnected · reconnecting'
    updatePermission()
    log('info', 'Disconnected; editing paused')
    if (credentials) reconnectTimer = setTimeout(connect, 1500)
    return
  }
  if (data.type === 'transport-error') { log('info', 'Transport error'); return }
  if (data.type !== 'message') return
  const message = data.message
  log('trace', `receive ${message.type}`, message.type === 'update' || message.type === 'snapshot' ? { bytes: message.update.length } : message)
  switch (message.type) {
    case 'snapshot':
      view?.destroy(); view = undefined
      doc?.destroy()
      if (pending.size) log('info', 'Reconnected to authority; unacknowledged edits may have been discarded', { count: pending.size })
      pending.clear()
      cursors.clear()
      doc = new Y.Doc()
      Y.applyUpdate(doc, decode(message.update))
      self = message.self
      files = message.files
      members.clear()
      for (const member of message.members) members.set(member.id, member)
      connected = true
      $('connection').textContent = 'Connected'
      $('lobby').hidden = true; $('workspace').hidden = false
      $('invite-link').value = `${location.origin}/#${credentials!.session}`
      $('files').replaceChildren(...files.map(file => { const button = document.createElement('button'); button.textContent = file; button.onclick = () => openFile(file); return button }))
      doc.on('update', (update, origin) => {
        if (origin !== 'remote') { const id = ++sequence; pending.add(id); send({ type: 'update', update: encodeUpdate(update), sequence: id }) }
        queueMicrotask(renderCursors)
      })
      openFile(files.includes(currentFile ?? '') ? currentFile! : files[0]!)
      renderMembers()
      log('info', 'Joined collaboration', { role: self!.role, files: files.length })
      break
    case 'update': if (doc) Y.applyUpdate(doc, decode(message.update), 'remote'); break
    case 'ack': pending.delete(message.sequence); log('debug', 'Edit acknowledged', { sequence: message.sequence }); break
    case 'member':
      members.set(message.member.id, message.member)
      if (!message.member.online) cursors.delete(message.member.id)
      if (message.member.id === self?.id) { self = message.member; updatePermission() }
      renderMembers(); renderCursors(); if (message.member.online) publishCursor()
      log('info', 'Participant changed', message.member)
      break
    case 'cursor': cursors.set(message.id, message); renderCursors(); break
    case 'error':
      log('info', 'Server rejected operation', { reason: message.message })
      $('error').textContent = message.message
      if (message.message === 'Invalid credentials') {
        credentials = undefined; sessionStorage.removeItem('collaboration.credentials')
        $('lobby').hidden = false; $('workspace').hidden = true
      }
      break
  }
}
async function enter(path: string, data: Record<string, unknown>): Promise<void> {
  try {
    $('error').textContent = ''
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    const result = await response.json() as Credentials & { error?: string }
    if (!response.ok) throw new Error(result.error ?? 'Request failed')
    credentials = result
    sessionStorage.setItem('collaboration.credentials', JSON.stringify(credentials))
    connect()
  } catch (error) { $('error').textContent = error instanceof Error ? error.message : String(error) }
}
$('host').onclick = async () => {
  try {
    let project
    const selected = Array.from($('folder').files ?? [])
    if (selected.length) {
      if (selected.length > 100 || selected.reduce((n, file) => n + file.size, 0) > 500_000) throw new Error('Project limit: 100 text files / 500 kB')
      project = Object.fromEntries(await Promise.all(selected.map(async file => {
        const text = await file.text()
        if (text.includes('\0')) throw new Error('Only text files are supported')
        return [file.webkitRelativePath.split('/').slice(1).join('/'), text]
      })))
    }
    await enter('/api/create', { name: $('name').value, files: project })
  } catch (error) { $('error').textContent = error instanceof Error ? error.message : String(error) }
}
$('join').onclick = () => enter('/api/join', { name: $('name').value, session: $('invitation').value.trim() })
$('request').onclick = () => send({ type: 'request-write' })
$('leave').onclick = () => { credentials = undefined; clearTimeout(reconnectTimer); sessionStorage.removeItem('collaboration.credentials'); worker.postMessage({ type: 'disconnect' }); location.hash = ''; location.reload() }
$('download').onclick = () => {
  const url = URL.createObjectURL(new Blob([doc!.getText(currentFile!).toString()], { type: 'text/plain' }))
  const link = document.createElement('a'); link.href = url; link.download = currentFile!.split('/').at(-1) ?? 'file.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
$('invitation').value = location.hash.slice(1)
try {
  const saved = JSON.parse(sessionStorage.getItem('collaboration.credentials') ?? 'null')
  if (saved && typeof saved.session === 'string' && typeof saved.token === 'string' && typeof saved.id === 'string' && (!location.hash || saved.session === location.hash.slice(1))) { credentials = saved as Credentials; connect() }
} catch { sessionStorage.removeItem('collaboration.credentials') }
window.addEventListener('beforeunload', () => worker.terminate())
