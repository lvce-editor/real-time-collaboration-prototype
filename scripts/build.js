import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/client.js', 'src/transport-worker.js'], bundle: true, format: 'esm', outdir: 'dist', sourcemap: true })
for (const file of ['index.html', 'style.css']) await copyFile(`src/${file}`, `dist/${file}`)
