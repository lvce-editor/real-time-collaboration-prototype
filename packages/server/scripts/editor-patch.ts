export function patchEditorSource(source: string, version: string, patch: string): string {
  if (version !== '19.60.2') throw new Error(`Unsupported LVCE editor-worker: ${version}`)
  const hook = 'const commandMap = {'
  const replacement = `${patch}\n${hook}\n  'Collaboration.snapshot': collaborationSnapshot,\n  'Collaboration.state': collaborationState,`
  if (source.includes(replacement)) return source
  if (source.includes("'Collaboration.snapshot':")) throw new Error('Unsupported existing collaboration patch; run npm ci to restore the pinned artifact')
  for (const anchor of [hook, 'const getEditor$1 =', 'const setText$1 =', 'const updateDerivedState =', 'const set$8 =']) {
    if (source.split(anchor).length !== 2) throw new Error(`Unsupported LVCE editor-worker: missing unique hook ${anchor}`)
  }
  return source.replace(hook, replacement)
}
