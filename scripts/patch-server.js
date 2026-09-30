import { readFile, writeFile } from 'node:fs/promises'

// Fail closed on upstream changes; npm ci reapplies these exact, idempotent hooks.
const url = new URL('../node_modules/@lvce-editor/server/src/server.js', import.meta.url)
let source = await readFile(url, 'utf8')
const patches = [
  ['const handleRequest = (req, res) => {', 'const handleRequest = (req, res) => {\n  if (globalThis.lvceCollaboration) return globalThis.lvceCollaboration.request(req, res)'],
  ['const handleUpgrade = (request, socket) => {', 'const handleUpgrade = (request, socket, head) => {\n  if (globalThis.lvceCollaboration) return globalThis.lvceCollaboration.upgrade(request, socket, head)'],
]
for (const [before, after] of patches) {
  if (source.includes(after)) continue
  if (source.split(before).length !== 2) throw new Error(`Unsupported LVCE server: missing unique hook ${before}`)
  source = source.replace(before, after)
}
await writeFile(url, source)
