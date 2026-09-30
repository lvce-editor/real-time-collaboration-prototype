const styleSheets = new Map<number, CSSStyleSheet>()

export const removeCssStyleSheet = (id: number): void => {
  const sheet = styleSheets.get(id)
  if (!sheet) return
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter(existing => existing !== sheet)
  styleSheets.delete(id)
}

export const addCssStyleSheet = (id: number, text: string): void => {
  const existing = styleSheets.get(id)
  if (existing) {
    existing.replaceSync(text)
    return
  }
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(text)
  styleSheets.set(id, sheet)
  document.adoptedStyleSheets.push(sheet)
}
