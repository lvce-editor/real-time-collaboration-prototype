import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
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
})
for (const file of ['index.html', 'style.css']) {
  await copyFile(new URL(file, collaborationSource), new URL(file, `file://${outputDirectory}/`))
}
