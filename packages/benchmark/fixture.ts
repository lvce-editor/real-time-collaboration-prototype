import { fork } from 'node:child_process'
import { fixture } from '@lvce-editor/real-time-collaboration/testing'
import type { Credentials } from '@lvce-editor/real-time-collaboration/server'

type Reply = { type: string; url: string; credentials: Credentials & Credentials[]; text: string; [key: string]: unknown }
export async function benchmarkFixture(separate: boolean) {
  if (!separate) {
    const f = await fixture()
    const credentials = f.create('Host', { 'benchmark.txt': '' })
    return { url: f.url, credentials, metrics: () => ({}), join: async (start: number, length: number) => Array.from({ length }, (_, j) => f.join(credentials.session, `User ${start + j}`)), text: async () => f.sessions.get(credentials.session)!.doc.getText('benchmark.txt').toString(), close: f.close }
  }
  const child = fork(new URL('./server.ts', import.meta.url), [], { execArgv: ['--max-old-space-size=768'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  let latest: Record<string, unknown> = {}
  child.on('message', (m: Reply) => { if (m.type === 'metrics') { const { type, ...metrics } = m; latest = metrics } })
  function wait(type: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { child.off('message', message); child.off('exit', exited); child.off('error', error) }
      const message = (m: Reply) => { if (m.type === type) { cleanup(); resolve(m) } }
      const exited = (code: number | null) => { cleanup(); reject(new Error(`Benchmark server exited ${code}`)) }
      const error = (e: Error) => { cleanup(); reject(e) }
      child.on('message', message); child.once('exit', exited); child.once('error', error)
    })
  }
  const ready = await wait('ready')
  return {
    url: ready.url, credentials: ready.credentials, metrics: () => latest,
    join: async (start: number, length: number): Promise<Credentials[]> => { const reply = wait('joined'); child.send({ type: 'join', start, length }); return (await reply).credentials },
    text: async () => { const reply = wait('summary'); child.send({ type: 'summary' }); const { type, text, ...metrics } = await reply; latest = metrics; return text },
    close: async () => { if (child.exitCode !== null || child.signalCode) return; const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); if (child.connected) child.send({ type: 'close' }); await exited },
  }
}
