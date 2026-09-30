const controlOrMeta = (event: KeyboardEvent): boolean => {
  return event.ctrlKey || event.metaKey
}

const getShortcutCommand = (event: KeyboardEvent): string => {
  if (!controlOrMeta(event)) {
    return ''
  }
  switch (event.key.toLowerCase()) {
    case 'a':
      return 'selectAll'
    case 'y':
      return 'redo'
    case 'z':
      return event.shiftKey ? 'redo' : 'undo'
    default:
      return ''
  }
}

const getHorizontalCommand = (event: KeyboardEvent): string => {
  if (event.key === 'ArrowLeft') {
    if (event.shiftKey) {
      return 'selectCharacterLeft'
    }
    return controlOrMeta(event) ? 'cursorWordLeft' : 'cursorLeft'
  }
  if (event.key === 'ArrowRight') {
    if (event.shiftKey) {
      return 'selectCharacterRight'
    }
    return controlOrMeta(event) ? 'cursorWordRight' : 'cursorRight'
  }
  return ''
}

const getNavigationCommand = (event: KeyboardEvent): string => {
  switch (event.key) {
    case 'Enter':
      return 'insertLineBreak'
    case 'ArrowDown':
      return event.shiftKey ? 'selectDown' : 'cursorDown'
    case 'ArrowUp':
      return event.shiftKey ? 'selectUp' : 'cursorUp'
    case 'Backspace':
      return controlOrMeta(event) ? 'deleteWordLeft' : 'deleteLeft'
    case 'Delete':
      return controlOrMeta(event) ? 'deleteWordRight' : 'deleteRight'
    case 'End':
      return controlOrMeta(event) ? 'cursorDocumentEnd' : 'cursorEnd'
    case 'Home':
      return controlOrMeta(event) ? 'cursorDocumentStart' : 'cursorHome'
    case 'PageDown':
      return 'cursorPageDown'
    case 'Tab':
      return 'handleTab'
    default:
      return ''
  }
}

export const getEditorCommand = (event: KeyboardEvent): string => {
  return getShortcutCommand(event) || getHorizontalCommand(event) || getNavigationCommand(event)
}
