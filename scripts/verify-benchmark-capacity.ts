import { readFile } from 'node:fs/promises'

type Result = { count: number; connected: number; status: string; converged: boolean; unexpectedCloses: number; writers: number; deliveries: number; mode: string; connectBatch: number }
const report = JSON.parse(await readFile('benchmark/results.json', 'utf8')) as { results: Result[]; combinedResults: Result[] }
const levels = [10, 100, 1000, 10000]
function levelsPresent(results: Result[]) {
  if (results.length !== levels.length || results.some((r, i) => r.count !== levels[i])) throw new Error('Missing benchmark levels')
}
levelsPresent(report.results); levelsPresent(report.combinedResults)
for (const result of report.results) {
  if (result.mode !== 'separate' || result.connectBatch !== 200 || result.status !== 'passed' || !result.converged || result.connected !== result.count || result.unexpectedCloses !== 0 || result.writers !== Math.min(10, result.count) || result.deliveries !== (result.count - 1) * result.writers) throw new Error(`Capacity regression at ${result.count} participants`)
}
for (const result of report.combinedResults) {
  if (result.mode !== 'combined' || result.connectBatch !== 20 || (result.count <= 100 && result.status !== 'passed')) throw new Error(`Original combined-process gate failed at ${result.count}`)
}
console.log('All capacity levels through 10,000 converge without disconnects; original combined-process gates preserved.')
