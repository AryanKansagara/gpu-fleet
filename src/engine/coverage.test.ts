import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { analyze, jobCoverage } from './analyze.ts'
import { FleetBuilder, jobsFromLabels, parseFile } from './parse.ts'
import { generate, SAMPLES } from './sample.ts'
import { DEFAULT_CONFIG, type Fleet, type Job } from './types.ts'

const T0 = Date.UTC(2026, 10, 12, 10)
const H = 3600_000
const STEP = 900
const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')

/** Telemetry for one GPU on `host`, 2 hours from T0 in 15-minute buckets. */
function fleet(host = 'dgx01'): Fleet {
  const b = new FleetBuilder(STEP)
  for (let i = 0; i < 8; i++) b.add(host, 0, T0 + i * STEP * 1000, 'sm', 0.5, { model: 'NVIDIA H100 80GB HBM3' })
  return b.build()
}
const job = (p: Partial<Job>): Job => ({ id: 'j', user: 'u', account: 'a', start: T0, end: T0 + H, gpus: 1, hosts: ['dgx01'], source: 'csv', ...p })

test('jobs wholly before or after the telemetry are named as outside it', () => {
  const f = fleet()
  const c = jobCoverage(f, [job({ id: 'early', start: T0 - 3 * H, end: T0 - H }), job({ id: 'late', start: T0 + 3 * H, end: T0 + 4 * H }), job({ id: 'in' })])
  assert.deepEqual(c.outside.map(j => j.id).sort(), ['early', 'late'])
  assert.deepEqual(c.unmatched, [])
  assert.equal(c.from, T0)
  assert.equal(c.to, T0 + 2 * H)
  // The report really does drop them: this is what the notice has to explain.
  assert.deepEqual(analyze(f, [job({ id: 'early', start: T0 - 3 * H, end: T0 - H })], DEFAULT_CONFIG).jobs, [])
})

test('a job that only touches the edge of the telemetry does not overlap it', () => {
  const f = fleet()
  const c = jobCoverage(f, [job({ id: 'ends-at-start', start: T0 - H, end: T0 }), job({ id: 'starts-at-end', start: T0 + 2 * H, end: T0 + 3 * H })])
  assert.deepEqual(c.outside.map(j => j.id).sort(), ['ends-at-start', 'starts-at-end'])
})

test('partial overlap, a longer job, and a short job inside a bucket all count as covered', () => {
  const f = fleet()
  const c = jobCoverage(f, [
    job({ id: 'starts-before', start: T0 - H, end: T0 + 30 * 60_000 }),
    job({ id: 'ends-after', start: T0 + 90 * 60_000, end: T0 + 5 * H }),
    job({ id: 'spans-all', start: T0 - H, end: T0 + 9 * H }),
    job({ id: 'short', start: T0 + 100_000, end: T0 + 200_000 }),
  ])
  assert.deepEqual(c.outside, [])
  assert.deepEqual(c.unmatched, [])
})

test('jobs on hosts with no telemetry are named, with the hosts, and are still listed by the report', () => {
  const f = fleet()
  const jobs = [job({ id: 'a', hosts: ['gpu07'] }), job({ id: 'b', hosts: ['gpu03', 'gpu07'], gpus: 2 }), job({ id: 'ok' })]
  const c = jobCoverage(f, jobs)
  assert.deepEqual(c.outside, [])
  assert.deepEqual(c.unmatched.map(j => j.id).sort(), ['a', 'b'])
  assert.deepEqual(c.unmatchedHosts, ['gpu03', 'gpu07'])
  const a = analyze(f, jobs, DEFAULT_CONFIG)
  assert.equal(a.byClass.nodata.jobs, 2)
})

test('a job with only some hosts missing is joined, not flagged', () => {
  const c = jobCoverage(fleet(), [job({ hosts: ['dgx01', 'dgx02'], gpus: 2 })])
  assert.deepEqual(c.unmatched, [])
  assert.deepEqual(c.outside, [])
})

test('FQDN telemetry matches short host names, case-insensitively, and an IP does not match a name', () => {
  const f = fleet('DGX01.ml.example.net')
  assert.deepEqual(jobCoverage(f, [job({ hosts: ['dgx01'] })]).unmatched, [])
  assert.equal(jobCoverage(f, [job({ hosts: ['10.0.0.1'] })]).unmatched.length, 1)
})

test('an outside job is reported once, even if its hosts have no telemetry either', () => {
  const c = jobCoverage(fleet(), [job({ id: 'x', start: T0 - 5 * H, end: T0 - 4 * H, hosts: ['nowhere'] })])
  assert.deepEqual(c.outside.map(j => j.id), ['x'])
  assert.deepEqual(c.unmatched, [])
})

test('no telemetry or no jobs gives nothing to report', () => {
  const none = jobCoverage({ t0: 0, step: STEP, n: 0, tracks: [] }, [job({})])
  assert.deepEqual([none.outside, none.unmatched, none.unmatchedHosts], [[], [], []])
  assert.deepEqual(jobCoverage(fleet(), []).outside, [])
})

test('jobs read from the scrape labels, and the sample clusters, are always inside their telemetry', () => {
  const f = fleet()
  const withLabels = parseFile(fixture('dcgm-exporter-4.9.prom'), { fileName: 'x.prom' }).fleet!
  const c = jobCoverage(withLabels, jobsFromLabels(withLabels))
  assert.deepEqual([c.outside.length, c.unmatched.length], [0, 0])
  assert.equal(jobCoverage(f, []).unmatched.length, 0)
  for (const s of SAMPLES) {
    const d = generate(s.id)
    const cov = jobCoverage(d.fleet!, d.jobs)
    assert.deepEqual([s.id, cov.outside.length, cov.unmatched.length], [s.id, 0, 0])
  }
})

test('the sacct fixture imported after the dcgm-exporter scrape is entirely outside the telemetry (issue 2)', () => {
  const metrics = parseFile(fixture('dcgm-exporter-4.9.prom'), { fileName: 'dcgm-exporter-4.9.prom' })
  const jobs = parseFile(fixture('sacct-mixed.psv'), { fileName: 'sacct-mixed.psv', now: Date.UTC(2026, 10, 24) })
  assert.equal(jobs.ok, 4)
  const c = jobCoverage(metrics.fleet!, jobs.jobs!)
  assert.deepEqual(c.outside.map(j => j.id).sort(), ['88120', '88121_3', '88122', '88123+0'])
  assert.equal(new Date(c.from).toISOString(), '2026-11-12T10:00:00.000Z')
  assert.equal(new Date(c.to).toISOString(), '2026-11-12T10:05:00.000Z')
  assert.equal(analyze(metrics.fleet!, jobs.jobs!, DEFAULT_CONFIG).jobs.length, 0)
})

test('"outside" is exactly the set of jobs the full-range report leaves out', () => {
  const f = fleet()
  const jobs: Job[] = []
  const edges = [-3 * H, -H, 0, 1, 100_000, 900_000, H, 2 * H - 1, 2 * H, 3 * H]
  for (const a of edges) for (const b of edges) jobs.push(job({ id: `${a}..${b}`, start: T0 + a, end: T0 + b }))
  const c = jobCoverage(f, jobs)
  const listed = new Set(analyze(f, jobs, DEFAULT_CONFIG).jobs.map(j => j.id))
  assert.deepEqual(new Set(jobs.filter(j => !listed.has(j.id)).map(j => j.id)), new Set(c.outside.map(j => j.id)))
  assert.ok(c.outside.length > 0 && listed.size > 0)
})
