import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const collaborationSource = new URL('../../collaboration/src/', import.meta.url)
const outputDirectory = fileURLToPath(new URL('../../../dist/', import.meta.url))
await mkdir(outputDirectory, { recursive: true })
await build({
  entryPoints: [
    fileURLToPath(new URL('client.ts', collaborationSource)),
    fileURLToPath(new URL('transport-worker.ts', collaborationSource)),
  ],
  bundle: true,
  format: 'esm',
  outdir: outputDirectory,
  sourcemap: true,
  external: ['node:*', 'electron', 'ws'],
})
for (const file of ['index.html', 'style.css']) {
  await copyFile(new URL(file, collaborationSource), new URL(file, `file://${outputDirectory}/`))
}

const require = createRequire(new URL('../../collaboration/package.json', import.meta.url))
await build({ entryPoints: [require.resolve('@lvce-editor/editor-worker')], bundle: true, format: 'esm', outfile: `${outputDirectory}/editorWorkerMain.js`, external: ['node:*', 'electron', 'ws'] })
await copyFile(new URL('native/index.css', collaborationSource), `${outputDirectory}/native.css`)

await build({ entryPoints: [require.resolve('@lvce-editor/syntax-highlighting-worker')], bundle: true, format: 'esm', outfile: `${outputDirectory}/syntaxHighlightingWorkerMain.js`, external: ['node:*', 'electron', 'ws'] })
