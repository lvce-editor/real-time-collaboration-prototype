import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const benchmarkPath = resolve('benchmark/results.json')
const sitePath = resolve('site')
type BenchmarkResult = {
  count: number
  connected?: number
  setupMs?: number
  writers?: number
  editMs?: number
  deliveriesPerSecond?: number
  p50Ms?: number
  p95Ms?: number
  peakRssBytes?: number
  status?: string
  reason?: string
}
type BenchmarkReport = {
  date: string
  node: string
  platform: string
  cpu: string
  workload: string
  results: BenchmarkResult[]
}
const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8')) as BenchmarkReport
const expectedLevels = [10, 100, 1000, 10000]
if (!Array.isArray(benchmark.results) || benchmark.results.length !== expectedLevels.length) {
  throw new Error(`Expected benchmark results for ${expectedLevels.join(', ')} participants`)
}
for (const [index, count] of expectedLevels.entries()) {
  if (benchmark.results[index]?.count !== count) throw new Error(`Expected benchmark level ${count}`)
}

const repository = process.env.GITHUB_REPOSITORY ?? 'lvce-editor/real-time-collaboration-prototype'
const sha = process.env.GITHUB_SHA ?? 'local'
const runId = process.env.GITHUB_RUN_ID
const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
const runUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : ''
const publishedResults = {
  ...benchmark,
  provenance: { repository, commit: sha, workflowRun: runId ?? null, workflowRunUrl: runUrl || null },
}
const htmlEscapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => htmlEscapes[char] ?? char)
const rows = benchmark.results.map(result => {
  const metrics = [
    ['Connected', `${result.connected ?? 0} / ${result.count}`],
    ['Setup', result.setupMs == null ? '—' : `${result.setupMs} ms`],
    ['Concurrent writers', result.writers ?? '—'],
    ['Edit propagation', result.editMs == null ? '—' : `${result.editMs} ms`],
    ['Deliveries / second', result.deliveriesPerSecond ?? '—'],
    ['Latency p50 / p95', result.p50Ms == null ? '—' : `${result.p50Ms} / ${result.p95Ms} ms`],
    ['Peak RSS', result.peakRssBytes == null ? '—' : `${(result.peakRssBytes / 1048576).toFixed(1)} MiB`],
  ]
  return `<article class="result ${result.status === 'passed' ? 'passed' : 'failed'}"><div class="result-heading"><h3>${result.count.toLocaleString()} participants</h3><span class="status">${esc(result.status ?? 'incomplete')}</span></div><dl>${metrics.map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${result.reason ? `<p class="failure">Failure: ${esc(result.reason)}</p>` : ''}</article>`
}).join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Main-branch real-time collaboration benchmark results for the LVCE editor prototype.">
  <title>Collaboration benchmark results</title>
  <style>
    :root { color-scheme: light; font: 16px/1.55 system-ui, sans-serif; color: #19222d; background: #f4f6f8; }
    body { margin: 0; }
    main { width: min(960px, calc(100% - 2rem)); margin: 3rem auto; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(2rem, 5vw, 3rem); line-height: 1.1; }
    .intro, .result, .demo { background: white; border: 1px solid #dce2e8; border-radius: 12px; padding: 1.25rem; }
    .intro { margin: 1.5rem 0; }
    .results { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 1rem; }
    .result-heading { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
    .result-heading h3 { margin-bottom: .75rem; }
    .status { font-weight: 700; text-transform: uppercase; font-size: .8rem; color: #286443; }
    .failed .status, .failure { color: #a02727; }
    dl { display: grid; grid-template-columns: 1fr 1fr; gap: .45rem 1rem; margin: 0; }
    dl div { display: flex; justify-content: space-between; gap: .5rem; border-bottom: 1px solid #edf0f2; }
    dt { color: #526170; } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .failure { margin: .8rem 0 0; overflow-wrap: anywhere; }
    .demo { margin-top: 1.5rem; }
    video { display: block; width: 100%; max-height: 540px; background: #101820; border-radius: 8px; }
    a { color: #075ca8; }
    footer { color: #526170; margin-top: 1.5rem; font-size: .9rem; overflow-wrap: anywhere; }
    @media (max-width: 520px) { dl { grid-template-columns: 1fr; } main { margin: 1.5rem auto; } }
  </style>
</head>
<body>
<main>
  <h1>Real-time collaboration benchmarks</h1>
  <p>Latest measurements from a successful benchmark workflow on the repository’s <code>main</code> branch.</p>
  <section class="intro" aria-labelledby="run-title">
    <h2 id="run-title">Run details</h2>
    <dl>
      <div><dt>Measured</dt><dd>${esc(benchmark.date)}</dd></div>
      <div><dt>Node.js</dt><dd>${esc(benchmark.node)}</dd></div>
      <div><dt>Operating system</dt><dd>${esc(benchmark.platform)}</dd></div>
      <div><dt>CPU</dt><dd>${esc(benchmark.cpu)}</dd></div>
      <div><dt>Commit</dt><dd><a href="${esc(`${serverUrl}/${repository}/commit/${sha}`)}">${esc(sha.slice(0, 12))}</a></dd></div>
      ${runUrl ? `<div><dt>Workflow run</dt><dd><a href="${esc(runUrl)}">${esc(runId)}</a></dd></div>` : ''}
      <div><dt>Workload</dt><dd>${esc(benchmark.workload)}</dd></div>
    </dl>
  </section>
  <section aria-labelledby="levels-title">
    <h2 id="levels-title">Participant levels</h2>
    <div class="results">${rows}</div>
  </section>
  <section class="demo" aria-labelledby="demo-title">
    <h2 id="demo-title">Collaboration in action</h2>
    <p>The browser demo shows two participants editing together and the remote participant cursor.</p>
    <video controls preload="metadata" poster="">
      <source src="./collaboration-demo.webm" type="video/webm">
      Your browser cannot play this collaboration recording.
    </video>
  </section>
  <footer><a href="./benchmark-results.json" download>Download benchmark results (JSON)</a>. Failed and capacity-limited levels are shown with their observed status and reason. These loopback WebSocket/Yjs measurements are not production capacity estimates.</footer>
</main>
</body>
</html>
`

await mkdir(sitePath, { recursive: true })
await writeFile(resolve(sitePath, 'benchmark-results.json'), `${JSON.stringify(publishedResults, null, 2)}\n`)
await writeFile(resolve(sitePath, 'index.html'), html)
