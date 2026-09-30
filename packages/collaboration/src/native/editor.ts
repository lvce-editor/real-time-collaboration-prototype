import type { Rpc } from '@lvce-editor/rpc'
import * as VirtualDom from '@lvce-editor/virtual-dom'
import * as Y from 'yjs'
import * as Viewlet from './viewlet.ts'
import { getEditorCommand } from './keyBinding.ts'
import { applyLocalText, offsetAt, positionAt, relativeSelections, resolveSelections } from './binding.ts'
import { launchWorker } from './worker.ts'

type State = { text: string; selections: number[]; rowHeight: number; charWidth: number; deltaX: number; deltaY: number }
type Queue = (operation: () => void | Promise<void>) => Promise<void>
export type Presence = { id: string; name: string; color: string; anchor: number; head: number }
let nextUid = 1

export class NativeEditor {
  private readonly uid = nextUid++
  private rpc!: Rpc
  private worker!: Worker
  private syntaxRpc!: Rpc
  private syntaxWorker!: Worker
  private disposed = false
  private canWrite = false
  private state!: State
  private resizeObserver!: ResizeObserver
  private readonly presence = document.createElement('div')
  private readonly mousedown = (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    this.parent.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true })
  }
  private readonly keydown = (event: KeyboardEvent) => {
    const command = getEditorCommand(event)
    if (!command) return
    event.preventDefault()
    this.execute(command)
  }

  private constructor(private parent: HTMLElement, readonly text: Y.Text, private queue: Queue, private changed: () => void) {}

  static async create(parent: HTMLElement, text: Y.Text, queue: Queue, changed: () => void): Promise<NativeEditor> {
    const editor = new NativeEditor(parent, text, queue, changed)
    try { await editor.initialize(); return editor } catch (error) { await editor.destroy(); throw error }
  }

  private bounds() {
    const { width, height, x, y } = this.parent.getBoundingClientRect()
    return { width, height, x, y }
  }

  private async initialize() {
    const syntax = await launchWorker('/syntaxHighlightingWorkerMain.js', {})
    this.syntaxWorker = syntax.worker
    this.syntaxRpc = syntax.rpc
    const editor = await launchWorker('/editorWorkerMain.js', {
      'Main.handleModifiedStatusChange': () => undefined,
      'SendMessagePortToSyntaxHighlightingWorker.sendMessagePortToSyntaxHighlightingWorker': (port: MessagePort, command: string) => this.syntaxRpc.invokeAndTransfer(command, port),
    })
    this.worker = editor.worker
    this.rpc = editor.rpc
    await this.rpc.invoke('Initialize.initialize', true, true)
    const context = document.createElement('canvas').getContext('2d')!
    context.font = '400 15px monospace'
    await this.rpc.invoke('Editor.createStandalone', {
      ...this.bounds(), id: this.uid, content: this.text.toString(), uri: 'untitled:collaboration',
      assetDir: '', charWidth: context.measureText('a').width, fontFamily: 'monospace', fontSize: 15,
      fontWeight: 400, languageId: 'plaintext', letterSpacing: 0, lineNumbers: false,
      platform: 1, rowHeight: 20, tabSize: 2, tokenizePath: '',
    })
    Viewlet.create(this.uid, this.parent)
    Viewlet.registerEventListeners(this.uid, await this.rpc.invoke('Editor.renderEventListeners'))
    VirtualDom.setIpc({ send: (method: string, uid: number, command: string, ...args: unknown[]) => {
      if (method === 'Viewlet.executeViewletCommand' && uid === this.uid) this.execute(command, ...args)
    } })
    this.parent.addEventListener('keydown', this.keydown, true)
    this.parent.addEventListener('mousedown', this.mousedown)
    this.presence.className = 'native-presence'
    this.parent.append(this.presence)
    await this.render()
    this.resizeObserver = new ResizeObserver(() => this.execute('resize', this.bounds()))
    this.resizeObserver.observe(this.parent)
  }

  private execute(command: string, ...args: unknown[]) {
    // UI commands cannot invoke filesystem/workbench RPC or revive old editors.
    if (this.disposed) return
    void this.queue(async () => {
      if (this.disposed) return
      const navigation = /^(cursor|select|handle(Mouse|Pointer|ScrollBar)|handleWheel$|handleFocus$|handleBlur$|handleKeyUp$|resize$)/.test(command)
      if (!this.canWrite && !navigation) return
      // Native history contains positional edits. Remote updates clear it to
      // prevent undo replaying another participant's edits.
      const before = this.text.toString()
      await this.rpc.invoke(`Editor.${command}`, this.uid, ...args)
      const state: State = await this.rpc.invoke('Collaboration.state', this.uid)
      if (!this.canWrite && state.text !== before) {
        await this.sync()
        return
      }
      applyLocalText(this.text, before, state.text)
      await this.render()
      this.changed()
    })
  }

  private async render() {
    const diff = await this.rpc.invoke('Editor.diff2', this.uid)
    Viewlet.executeCommands(await this.rpc.invoke('Editor.render2', this.uid, diff))
    this.state = await this.rpc.invoke('Collaboration.state', this.uid)
    const input = this.parent.querySelector<HTMLTextAreaElement>('textarea')
    if (input) { input.readOnly = !this.canWrite; input.setAttribute('aria-label', 'LVCE editor input') }
    this.parent.dataset.ready = 'true'
    this.parent.dataset.readonly = String(!this.canWrite)
  }

  setEditable(editable: boolean) {
    this.canWrite = editable
    const input = this.parent.querySelector<HTMLTextAreaElement>('textarea')
    if (input) input.readOnly = !editable
    this.parent.dataset.readonly = String(!editable)
  }

  get selection() {
    const { selections, text } = this.state
    return { anchor: offsetAt(text, selections[0], selections[1]), head: offsetAt(text, selections[2], selections[3]) }
  }

  captureSelection() { return relativeSelections(this.text, this.state.selections) }

  async sync(positions = this.captureSelection()) {
    if (this.disposed) return
    await this.rpc.invoke('Collaboration.snapshot', this.uid, this.text.toString(), resolveSelections(this.text, positions))
    await this.render()
  }

  renderPresence(participants: Presence[]) {
    this.presence.replaceChildren()
    const { charWidth, rowHeight, deltaX, deltaY } = this.state
    const value = this.text.toString()
    for (const participant of participants) {
      const [row, column] = positionAt(value, participant.head)
      const cursor = document.createElement('span')
      cursor.className = 'remote-cursor'
      cursor.dataset.participant = participant.id
      Object.assign(cursor.style, { left: `${column * charWidth - deltaX}px`, top: `${row * rowHeight - deltaY}px`, height: `${rowHeight}px`, borderColor: participant.color })
      const label = cursor.appendChild(document.createElement('span'))
      label.className = 'remote-cursor-label'; label.textContent = participant.name; label.style.background = participant.color
      this.presence.append(cursor)
      const [startRow, startColumn] = positionAt(value, Math.min(participant.anchor, participant.head))
      const [endRow, endColumn] = positionAt(value, Math.max(participant.anchor, participant.head))
      const lines = value.split('\n')
      for (let i = startRow; i <= endRow; i++) {
        const start = i === startRow ? startColumn : 0, end = i === endRow ? endColumn : lines[i].length + 1
        const mark = document.createElement('span')
        mark.className = 'remote-selection'
        Object.assign(mark.style, { left: `${start * charWidth - deltaX}px`, top: `${i * rowHeight - deltaY}px`, width: `${(end - start) * charWidth}px`, height: `${rowHeight}px`, background: `${participant.color}44` })
        this.presence.append(mark)
      }
    }
  }

  async destroy() {
    this.disposed = true
    this.resizeObserver?.disconnect()
    this.parent.removeEventListener('keydown', this.keydown, true)
    this.parent.removeEventListener('mousedown', this.mousedown)
    delete this.parent.dataset.ready
    this.presence.remove()
    try { if (this.rpc) await this.rpc.invoke('Editor.dispose', this.uid) } finally {
      await this.rpc?.dispose()
      this.worker?.terminate()
      await this.syntaxRpc?.dispose()
      this.syntaxWorker?.terminate()
      if (VirtualDom.getViewletInstance(this.uid)) Viewlet.dispose(this.uid)
    }
  }
}
