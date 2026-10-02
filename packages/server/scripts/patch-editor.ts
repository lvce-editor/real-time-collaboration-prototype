import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { patchEditorSource } from './editor-patch.ts'

const require = createRequire(new URL('../../collaboration/package.json', import.meta.url))
const root = dirname(require.resolve('@lvce-editor/editor-worker/package.json'))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const file = join(root, 'dist/editorWorkerMain.js')
const source = await readFile(file, 'utf8')
const patch = await readFile(new URL('../patches/editor-collaboration.js', import.meta.url), 'utf8')
const patched = patchEditorSource(source, manifest.version, patch)
if (patched !== source) await writeFile(file, patched)
