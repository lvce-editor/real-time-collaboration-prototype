import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'

const htmlPath = resolve('site/index.html')
const jsonPath = resolve('site/benchmark-results.json')
const html = await readFile(htmlPath, 'utf8')
type PublishedReport = {
  provenance?: { repository?: string; commit?: string; workflowRun?: string | null }
  results?: Array<{ count: number; status: string; reason?: string }>
}
const report = JSON.parse(await readFile(jsonPath, 'utf8')) as PublishedReport
const expectedLevels = [10, 100, 1000, 10000]
for (const fragment of ['href="./benchmark-results.json"', 'src="./collaboration-demo.webm"', 'Real-time collaboration benchmarks', 'four participants contributing edits together for at least one minute', 'Failed and capacity-limited levels are shown']) {
  if (!html.includes(fragment)) throw new Error(`Generated report is missing ${fragment}`)
}
if (report.results?.length !== expectedLevels.length || report.results.some((result, index) => result.count !== expectedLevels[index])) {
  throw new Error('Published JSON does not contain all four benchmark levels in order')
}
if (!report.provenance?.repository || !report.provenance?.commit || !('workflowRun' in report.provenance)) {
  throw new Error('Published JSON is missing workflow provenance')
}
for (const result of report.results) {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const safeReason = String(result.reason ?? '').replace(/[&<>"']/g, char => entities[char] ?? char)
  if (result.status !== 'passed' && !result.reason) throw new Error(`Failed ${result.count}-participant result has no failure reason`)
  if (result.status !== 'passed' && !html.includes(safeReason)) {
    throw new Error(`Failure reason for ${result.count} participants is not visible in the report`)
  }
}
if (process.env.REQUIRE_DEMO_VIDEO === 'true') await access(resolve('site/collaboration-demo.webm'))
console.log('Report contains four benchmark levels, run provenance, downloadable JSON and relative media assets.')
