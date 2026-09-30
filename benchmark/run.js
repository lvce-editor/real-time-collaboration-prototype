import { fork } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
const levels = process.argv.slice(2).map(Number)
const results = []
for (const count of levels.length ? levels : [10, 100, 1000, 10000]) {
  const result = await new Promise(resolve => {
    let latest = { count, connected: 0 }, stderr = '', settled = false
    const child = fork(new URL('./scenario.js', import.meta.url), [String(count)], { execArgv: ['--max-old-space-size=768'], silent: true })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    const finish = result => { if (settled) return; settled = true; clearTimeout(timeout); resolve(result) }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); finish({ ...latest, status: 'failed', reason: '45-second capacity deadline exceeded' }) }, 45_000)
    child.on('message', message => { latest = message; if (message.status) finish(message) })
    child.on('exit', code => { if (!settled) finish({ ...latest, status: 'failed', reason: `Child exited ${code}`, stderr }) })
    child.on('error', error => finish({ ...latest, status: 'failed', reason: error.message }))
  })
  results.push(result)
  console.log(JSON.stringify(result))
}
const report = { date: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, workload: 'Real loopback WebSockets, one project, all clients receive presence, up to ten concurrent CRDT writers; not full editor/browser clients. 45 s deadline and 768 MiB JS heap per scenario.', results }
await writeFile('benchmark/results.json', JSON.stringify(report, null, 2) + '\n')
