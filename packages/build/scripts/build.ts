import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildWorkbench } from '../../server/scripts/workbench-patch.ts'

const collaborationSource = new URL('../../collaboration/src/', import.meta.url)
const outputDirectory = fileURLToPath(new URL('../../../dist/', import.meta.url))
await mkdir(outputDirectory, { recursive: true })
await build({
  entryPoints: ['workbench-client.ts', 'transport-worker.ts'].map(file => fileURLToPath(new URL(file, collaborationSource))),
  bundle: true,
  format: 'esm',
  outdir: outputDirectory,
  sourcemap: true,
  external: ['node:*', 'electron', 'ws'],
})
await buildWorkbench(outputDirectory)
await copyFile(new URL('workbench.css', collaborationSource), `${outputDirectory}/collaboration.css`)
