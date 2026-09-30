import { applyPatch, getViewletInstance, registerEventListeners, rememberFocus, setComponentUid, setViewletInstance } from '@lvce-editor/virtual-dom'
import { addCssStyleSheet, removeCssStyleSheet } from './css.ts'

const ignoreCommand = (): void => {}

const getElement = (uid: number): HTMLElement => {
  const instance = getViewletInstance(uid)
  const element = instance?.state?.$Viewlet
  if (!(element instanceof HTMLElement)) {
    throw new TypeError(`Editor element ${uid} not found`)
  }
  return element
}

const create = (uid: number, parent: HTMLElement): void => {
  const element = document.createElement('div')
  setComponentUid(element, uid)
  setViewletInstance(uid, {
    factory: {},
    state: {
      $Viewlet: element,
    },
  })
  parent.append(element)
}

const dispose = (uid: number): void => {
  getElement(uid).remove()
  setViewletInstance(uid, undefined)
  removeCssStyleSheet(uid)
}

const focusSelector = (uid: number, selector: string): void => {
  const element = getElement(uid).querySelector<HTMLElement>(selector)
  element?.focus()
}

const focusSelectorAfterRender = (uid: number, selector: string): void => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      focusSelector(uid, selector)
    })
  })
}

const scrollSelectorBy = (uid: number, selector: string, delta: number): void => {
  const element = getElement(uid).querySelector<HTMLElement>(selector)
  if (element) {
    element.scrollLeft += delta
  }
}

const scrollSelectorIntoView = (uid: number, selector: string): void => {
  getElement(uid).querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

const setBounds = (uid: number, left: number, top: number, width: number, height: number): void => {
  const element = getElement(uid)
  element.style.left = `${left}px`
  element.style.top = `${top}px`
  element.style.width = `${width}px`
  element.style.height = `${height}px`
}

const setPatches = (uid: number, patches: readonly any[]): void => {
  const element = getElement(uid)
  if (patches.length === 1 && patches[0]?.type === 6) {
    const replacement = rememberFocus(element, patches[0].nodes, {}, uid)
    setComponentUid(replacement, uid)
    const instance = getViewletInstance(uid)
    setViewletInstance(uid, {
      ...instance,
      state: {
        ...instance.state,
        $Viewlet: replacement,
      },
    })
    return
  }
  applyPatch(element, patches, {}, uid)
}

const setSelectionByName = (uid: number, name: string, start: number, end: number): void => {
  const input = getElement(uid).querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`)
  if (!input) {
    return
  }
  input.selectionStart = start
  input.selectionEnd = end
}

const setUid = (uid: number, componentUid: number): void => {
  setComponentUid(getElement(uid), componentUid)
}

const setValueByName = (uid: number, name: string, value: string): void => {
  const input = getElement(uid).querySelector<HTMLInputElement>(`[name="${CSS.escape(name)}"]`)
  if (input) {
    input.value = value
  }
}

const commandHandlers: Record<string, (...args: any[]) => unknown> = {
  'Viewlet.dispose': dispose,
  'Viewlet.setWidgets': (_uid, _revision, widgets) => { if (widgets.length) throw new Error('Workbench widgets are unavailable in collaboration') },
  'Viewlet.focusSelector': focusSelector,
  'Viewlet.focusSelectorAfterRender': focusSelectorAfterRender,
  'Viewlet.scrollSelectorBy': scrollSelectorBy,
  'Viewlet.scrollSelectorIntoView': scrollSelectorIntoView,
  'Viewlet.setAdditionalFocus': ignoreCommand,
  'Viewlet.setBounds': setBounds,
  'Viewlet.setCss': addCssStyleSheet,
  'Viewlet.setFocusContext': ignoreCommand,
  'Viewlet.setPatches': setPatches,
  'Viewlet.setSelectionByName': setSelectionByName,
  'Viewlet.setUid': setUid,
  'Viewlet.setValueByName': setValueByName,
  'Viewlet.unsetAdditionalFocus': ignoreCommand,
}

export const executeCommands = (commands: readonly (readonly any[])[]): void => {
  for (const [command, ...args] of commands) {
    const handler = commandHandlers[command]
    if (!handler) {
      throw new Error(`Unsupported editor-only render command: ${command}`)
    }
    handler(...args)
  }
}

export { create, dispose, registerEventListeners }
