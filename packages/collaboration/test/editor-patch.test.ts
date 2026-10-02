import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { patchEditorSource } from '../../server/scripts/editor-patch.ts'

test('installed native worker patch is repeatable and unsupported versions fail closed', async () => {
  const require = createRequire(import.meta.url)
  const source = await readFile(require.resolve('@lvce-editor/editor-worker'), 'utf8')
  const patch = await readFile(new URL('../../server/patches/editor-collaboration.js', import.meta.url), 'utf8')
  const patched = patchEditorSource(source, '19.60.2', patch)
  assert.equal(patchEditorSource(patched, '19.60.2', patch), patched)
  assert.throws(() => patchEditorSource(source, '19.60.3', patch), /Unsupported LVCE/)
  assert.throws(() => patchEditorSource('const commandMap = {}', '19.60.2', patch), /missing unique hook/)
  assert.equal(patched.split("'Collaboration.snapshot':").length, 2)
})
