import { access, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'

// Fail closed on upstream changes; npm ci reapplies these exact, idempotent hooks.
const require = createRequire(import.meta.url)
const entry = require.resolve('@lvce-editor/server')
let directory = dirname(entry)
let serverFile
while (directory !== parse(directory).root) {
  const candidate = join(directory, 'src/server.js')
  try {
    await access(candidate)
    serverFile = candidate
    break
  } catch {}
  directory = dirname(directory)
}
if (!serverFile) throw new Error(`Could not locate @lvce-editor/server/src/server.js from ${entry}`)
const url = pathToFileURL(serverFile)
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
