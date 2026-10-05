import { fork } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
const levels = process.argv.slice(2).map(Number)
type BenchmarkResult = { count: number; connected: number; status?: string; [key: string]: unknown }
async function measure(mode: 'combined' | 'separate', batch: number) {
  const results: BenchmarkResult[] = []
  for (const count of levels.length ? levels : [10, 100, 1000, 10000]) {
    const result = await new Promise<BenchmarkResult>(resolve => {
      let latest: BenchmarkResult = { count, connected: 0, mode, connectBatch: batch }, stderr = '', settled = false
      const child = fork(new URL('./scenario.ts', import.meta.url), [String(count)], { execArgv: ['--max-old-space-size=768'], env: { ...process.env, BENCHMARK_PROCESSES: mode, BENCHMARK_CONNECT_BATCH: String(batch) }, silent: true })
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
      const finish = (result: BenchmarkResult) => { if (settled) return; settled = true; clearTimeout(timeout); resolve({ ...result, mode }) }
      const timeout = setTimeout(() => { child.kill('SIGKILL'); finish({ ...latest, status: 'failed', reason: '45-second capacity deadline exceeded' }) }, 45_000)
      child.on('message', message => { latest = message as BenchmarkResult })
      child.on('exit', code => { if (!settled) finish(latest.status && code === 0 ? latest : { ...latest, status: 'failed', reason: `Child exited ${code}`, stderr }) })
      child.on('error', error => finish({ ...latest, status: 'failed', reason: error.message }))
    })
    results.push(result)
    console.log(JSON.stringify(result))
  }
  return results
}
// Retain the original 20-at-a-time single-process diagnostic and its CI gates.
// Capacity is measured with an independent server and 200-at-a-time ramp.
const mode = process.env.BENCHMARK_PROCESSES
const batch = Number(process.env.BENCHMARK_CONNECT_BATCH)
const combinedResults = mode === 'separate' ? [] : await measure('combined', batch || 20)
const results = mode === 'combined' ? combinedResults : await measure('separate', batch || 200)
const report = { date: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, workload: 'Real loopback WebSockets, one project, complete presence, up to ten concurrent CRDT writers; not full editor/browser clients. Capacity: separate server/load-generator processes, connection ramp 200. Diagnostic: combined process, ramp 20. Each level has a 45 s deadline and 768 MiB JS heap per process (combined: one process; capacity: two). Load generator shares immutable decoded presence using bounded caches; browser processes do not. RSS is not a JS heap limit.', results, combinedResults }
const output = fileURLToPath(new URL('../../benchmark/results.json', import.meta.url))
await mkdir(dirname(output), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
