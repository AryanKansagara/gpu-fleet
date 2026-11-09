import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, heatmap, jobStats, migPlan, monthWindow, months, p95, place, simulate } from './analyze.ts'
import { migCommands, migGpu, packProfiles, pickProfile } from './mig.ts'
import { autoMap, detectFormat, expandHostlist, FleetBuilder, gpuClass, gpuMemMiB, jobsFromLabels, mergeFleets, ownerFromLabels, parseCsv, parseElapsed, parseFile, parseIdx, parseTime, parseTres } from './parse.ts'
import { jobsCsv, migPartedYaml, reaperScript, userNote } from './policy.ts'
import { generate } from './sample.ts'
import { DEFAULT_CONFIG, type Fleet, type Job } from './types.ts'

const T0 = Date.UTC(2026, 9, 1)
const H = 3600_000
const cfg = DEFAULT_CONFIG

/** A fleet of one host with `gpus` GPUs, 900 s buckets, with per-GPU SM functions. */
function fleetOf(gpus: number, hours: number, sm: (g: number, b: number) => number, fb: (g: number, b: number) => number = () => 20000, host = 'n1', model = 'NVIDIA H100 80GB HBM3'): Fleet {
  const b = new FleetBuilder(900)
  for (let g = 0; g < gpus; g++) for (let i = 0; i < hours * 4; i++) {
    b.add(host, g, T0 + i * 900_000, 'sm', sm(g, i), { model })
    b.add(host, g, T0 + i * 900_000, 'fb', fb(g, i))
    b.add(host, g, T0, 'memTotal', 81559)
  }
  return b.build()
}
const job = (p: Partial<Job>): Job => ({ id: 'j1', user: 'u', account: 'a', start: T0, end: T0 + 24 * H, gpus: 1, hosts: ['n1'], source: 'csv', ...p })

// ---------- Parsing ----------

test('hostlist expansion keeps zero padding and mixed lists', () => {
  assert.deepEqual(expandHostlist('gpu[01-03,07],login1'), ['gpu01', 'gpu02', 'gpu03', 'gpu07', 'login1'])
  assert.deepEqual(expandHostlist('dgx-a[9-11]'), ['dgx-a9', 'dgx-a10', 'dgx-a11'])
  assert.deepEqual(expandHostlist('None assigned'), [])
})

test('AllocTRES: generic gres/gpu count wins, typed gres gives the model', () => {
  assert.deepEqual(parseTres('billing=64,cpu=64,gres/gpu:h100=8,gres/gpu=8,mem=1000G,node=1'), { gpus: 8, model: 'h100' })
  assert.deepEqual(parseTres('cpu=8,gres/gpu:a100=2,mem=64G'), { gpus: 2, model: 'a100' })
  assert.equal(parseTres('cpu=8,mem=64G').gpus, 0)
  assert.equal(parseTres('4').gpus, 4)
})

test('Slurm elapsed, GPU index lists and timestamps', () => {
  assert.equal(parseElapsed('1-02:03:04'), 86400 + 7200 + 180 + 4)
  assert.equal(parseElapsed('05:30'), 330)
  assert.deepEqual(parseIdx('IDX:0-2,5'), [0, 1, 2, 5])
  assert.equal(parseTime('2026/10/01 12:00:00.500'), Date.UTC(2026, 9, 1, 12, 0, 0, 500))
  assert.equal(parseTime('2026-10-01T12:00:00+02:00'), Date.UTC(2026, 9, 1, 10))
  assert.equal(parseTime('1790000000'), 1790000000000)
})

test('format detection across the supported exports', () => {
  assert.equal(detectFormat('JobID|JobName|User|Account|AllocTRES|Start|End|NodeList\n1|x|u|a|gres/gpu=1|...'), 'sacct')
  assert.equal(detectFormat('timestamp, index, uuid, name, utilization.gpu [%], memory.used [MiB]\n'), 'nvidia-smi')
  assert.equal(detectFormat('{"status":"success","data":{"resultType":"matrix","result":[]}}'), 'prom-json')
  assert.equal(detectFormat('{"apiVersion":"v1","items":[]}'), 'k8s-json')
  assert.equal(detectFormat('NAMESPACE   POD   NODE   GPUS   START\n'), 'k8s-columns')
  assert.equal(detectFormat('time,Hostname,gpu,__name__,value\n'), 'prom-csv')
})

test('sacct import: skips steps and CPU-only jobs, reports line numbers', () => {
  const text = [
    'JobID|JobName|User|Account|Partition|State|Start|End|Elapsed|NNodes|NodeList|AllocTRES',
    '100|train|ann|vision|gpu|COMPLETED|2026-10-01T00:00:00|2026-10-01T10:00:00|10:00:00|2|gpu[01-02]|cpu=64,gres/gpu=16,node=2',
    '100.batch|batch|ann|vision|gpu|COMPLETED|2026-10-01T00:00:00|2026-10-01T10:00:00|10:00:00|1|gpu01|cpu=32',
    '101|cpu-only|bob|nlp|cpu|COMPLETED|2026-10-01T00:00:00|2026-10-01T01:00:00|01:00:00|1|cpu01|cpu=4',
    '102|bad|bob|nlp|gpu|FAILED|not-a-date|Unknown|00:00:00|1|gpu03|gres/gpu=1',
    '103|jupyter|cat|nlp|interactive|RUNNING|2026-10-02T00:00:00|Unknown|1-00:00:00|1|gpu03|gres/gpu:h100=1',
  ].join('\n')
  const r = parseFile(text, { now: Date.UTC(2026, 9, 5) })
  assert.equal(r.format, 'sacct')
  assert.equal(r.ok, 2)
  assert.deepEqual(r.jobs![0].hosts, ['gpu01', 'gpu02'])
  assert.equal(r.jobs![0].gpus, 16)
  assert.equal(r.jobs![1].end, Date.UTC(2026, 9, 3), 'running job end = start + elapsed')
  assert.ok(r.issues.some(i => i.line === 5 && i.level === 'error'), 'bad start reported on line 5')
  assert.ok(r.issues.some(i => i.line === 4 && /no GPUs/.test(i.message)))
})

test('Prometheus range-query JSON: metric names, exported_pod owner, percent and ratio scaling', () => {
  const body = {
    status: 'success', data: { resultType: 'matrix', result: [
      { metric: { __name__: 'DCGM_FI_PROF_SM_ACTIVE', gpu: '0', UUID: 'GPU-1', Hostname: 'node-a', modelName: 'NVIDIA A100-SXM4-80GB', pod: 'dcgm-exporter-x', exported_pod: 'llm-0', exported_namespace: 'serving' }, values: [[1790000000, '0.5'], [1790000060, '0.7']] },
      { metric: { __name__: 'DCGM_FI_DEV_FB_USED', gpu: '0', Hostname: 'node-a' }, values: [[1790000000, '30000'], [1790000060, '42000']] },
      { metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', gpu: '1', Hostname: 'node-a' }, values: [[1790000000, '80']] },
      { metric: { gpu: '0' }, values: [[1790000000, '1']] },
    ] },
  }
  const r = parseFile(JSON.stringify(body), { step: 300 })
  const [g0, g1] = r.fleet!.tracks
  assert.equal(g0.sm.find(Number.isFinite), 0.6, 'two samples averaged in one bucket')
  assert.equal(g0.fb.find(Number.isFinite), 42000, 'framebuffer keeps the peak')
  assert.equal(g0.owner.find(Boolean), 'serving/llm-0')
  assert.equal(g1.smProxy, true)
  assert.equal(g1.sm.find(Number.isFinite), 0.8, 'GPU_UTIL percent scaled to a ratio')
  assert.ok(r.issues.some(i => i.level === 'error' && /unknown metric/.test(i.message)))
  assert.ok(r.issues.some(i => /upper bound/.test(i.message)))
})

test('nvidia-smi log: host from file name, units stripped, memory total kept', () => {
  const text = 'timestamp, index, uuid, name, utilization.gpu [%], memory.used [MiB], memory.total [MiB], power.draw [W]\n' +
    '2026/10/01 00:00:00.000, 0, GPU-aa, NVIDIA L4, 35 %, 12000 MiB, 23034 MiB, 40.5 W\n' +
    '2026/10/01 00:01:00.000, 0, GPU-aa, NVIDIA L4, [N/A], 12100 MiB, 23034 MiB, 41 W\n'
  const r = parseFile(text, { fileName: 'nvidia-smi-worker7.csv' })
  assert.equal(r.format, 'nvidia-smi')
  const t = r.fleet!.tracks[0]
  assert.equal(t.host, 'worker7')
  assert.equal(t.memMiB, 23034)
  assert.equal(t.smProxy, true)
  assert.equal(t.sm.find(Number.isFinite), 0.35)
})

test('kubectl pods JSON: GPU pods only, team label over namespace', () => {
  const pods = { items: [
    { metadata: { name: 'nb-0', namespace: 'notebooks', labels: { team: 'vision', user: 'mei' } }, spec: { nodeName: 'n1', containers: [{ resources: { limits: { 'nvidia.com/gpu': '1' } } }] }, status: { phase: 'Running', startTime: '2026-10-01T00:00:00Z' } },
    { metadata: { name: 'web', namespace: 'default' }, spec: { nodeName: 'n2', containers: [{}] }, status: { startTime: '2026-10-01T00:00:00Z' } },
  ] }
  const r = parseFile(JSON.stringify(pods), { now: T0 + 5 * H })
  assert.equal(r.jobs!.length, 1)
  assert.equal(r.jobs![0].id, 'notebooks/nb-0')
  assert.equal(r.jobs![0].account, 'vision')
  assert.equal(r.jobs![0].end, T0 + 5 * H)
})

test('autoMap finds DCGM wide columns and owner label precedence', () => {
  const m = autoMap(['timestamp', 'Hostname', 'gpu', 'DCGM_FI_PROF_SM_ACTIVE', 'DCGM_FI_DEV_FB_USED'], 'metrics')
  assert.deepEqual([m.time, m.host, m.gpu, m.sm, m.fb], [0, 1, 2, 3, 4])
  assert.equal(ownerFromLabels({ hpc_job: '42', pod: 'x' }), '42')
  assert.equal(ownerFromLabels({ pod: 'dcgm-exporter-abc', namespace: 'gpu-operator' }), null)
  assert.equal(gpuClass('NVIDIA A100-SXM4-40GB'), 'A100')
  assert.equal(gpuMemMiB('NVIDIA A100-SXM4-40GB'), 40 * 1024)
})

test('merging fleets keeps both imports and the bucket step', () => {
  const a = fleetOf(1, 2, () => 0.5)
  const b = fleetOf(1, 2, () => 0.5, undefined, 'n2')
  const m = mergeFleets(a, b)
  assert.equal(m.tracks.length, 2)
  assert.equal(m.step, 900)
  assert.equal(m.n, 8)
})

// ---------- Join and metrics ----------

test('join prefers known GPU indices, then owner labels, then lowest free GPUs', () => {
  const f = fleetOf(4, 4, () => 0.5)
  f.tracks[3].owner = f.tracks[3].owner.map(() => 'labelled')
  const pls = place(f, [
    job({ id: 'known', gpus: 1, gpuIdx: { n1: [2] }, end: T0 + 4 * H }),
    job({ id: 'labelled', gpus: 1, end: T0 + 4 * H }),
    job({ id: 'guess', gpus: 2, end: T0 + 4 * H }),
  ])
  const by = Object.fromEntries(pls.map(p => [p.job.id, p]))
  assert.deepEqual(by.known.cells.map(c => f.tracks[c.t].gpu), [2])
  assert.deepEqual(by.labelled.cells.map(c => f.tracks[c.t].gpu), [3])
  assert.deepEqual(by.guess.cells.map(c => f.tracks[c.t].gpu), [0, 1])
  assert.equal(by.guess.inferred, true)
  assert.equal(by.known.inferred, false)
})

test('per-job stats: GPU-hours, idle hours, time at zero, p95', () => {
  // 8 hours on 1 GPU: first 2 h busy at 0.8, rest at 0.
  const f = fleetOf(1, 8, (_, b) => b < 8 ? 0.8 : 0)
  const [pl] = place(f, [job({ end: T0 + 8 * H })])
  const s = jobStats(f, pl, cfg)!
  assert.equal(s.gpuHours, 8)
  assert.equal(s.idleGpuHours, 6)
  assert.equal(s.timeAtZero, 0.75)
  assert.ok(Math.abs(s.meanSm - 0.2) < 1e-9)
  assert.equal(s.p95Sm, 0.8)
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), 19)
})

test('classifies an abandoned notebook as idle and recommends release', () => {
  const f = fleetOf(1, 24, (_, b) => b < 4 ? 0.3 : 0, () => 18000)
  const [pl] = place(f, [job({ name: 'jupyter', end: T0 + 24 * H })])
  const s = jobStats(f, pl, cfg)!
  assert.equal(s.cls, 'idle')
  assert.equal(s.notebook, true)
  assert.equal(s.rec.kind, 'release')
  assert.equal(s.rec.gpusAfter, 0)
})

test('an 8-GPU job that only uses 2: imbalance high, recommend 2 GPUs', () => {
  const f = fleetOf(8, 12, g => g < 2 ? 0.7 : 0.003, g => g < 2 ? 50000 : 500)
  const [pl] = place(f, [job({ gpus: 8, end: T0 + 12 * H })])
  const s = jobStats(f, pl, cfg)!
  assert.equal(s.activeGpus, 2)
  assert.ok(s.imbalance > 0.7)
  assert.equal(s.cls, 'under')
  assert.equal(s.rec.kind, 'fewer')
  assert.equal(s.rec.newGpus, 2)
})

test('steady light inference fits a MIG slice; a saturated trainer is left alone', () => {
  const f = fleetOf(2, 12, g => g === 0 ? 0.12 : 0.9, g => g === 0 ? 9000 : 78000)
  const pls = place(f, [job({ id: 'inf', gpuIdx: { n1: [0] }, end: T0 + 12 * H }), job({ id: 'train', gpuIdx: { n1: [1] }, end: T0 + 12 * H })])
  const inf = jobStats(f, pls[0], cfg)!
  const train = jobStats(f, pls[1], cfg)!
  assert.equal(inf.cls, 'membound')
  assert.equal(inf.rec.kind, 'mig')
  assert.equal(inf.rec.profile, '1g.20gb', '9000 MiB + 15% headroom needs more than 10 GB')
  assert.equal(train.cls, 'saturated')
  assert.equal(train.rec.kind, 'none')
})

test('MIG profile choice respects both memory and compute, and A100 40GB vs 80GB tables', () => {
  const h100 = migGpu('NVIDIA H100 80GB HBM3')!
  assert.equal(pickProfile(h100, 5000, 0.1, 0.15)!.name, '1g.10gb')
  assert.equal(pickProfile(h100, 5000, 0.25, 0.15)!.name, '2g.20gb', 'p95 25% needs 2 of 7 slices')
  assert.equal(pickProfile(h100, 60000, 0.2, 0.15), null, 'only the full GPU has the memory')
  assert.equal(migGpu('NVIDIA A100-SXM4-40GB')!.label, 'A100 40GB')
  assert.equal(migGpu('NVIDIA L4'), null)
})

test('MIG packing never exceeds compute or memory slices and emits commands', () => {
  const h100 = migGpu('H100 80GB')!
  const layout = packProfiles(h100, ['3g.40gb', '3g.40gb', '2g.20gb', '1g.10gb', '1g.10gb', '1g.10gb'])
  for (const gpu of layout) {
    const ps = gpu.map(n => h100.profiles.find(p => p.name === n)!)
    assert.ok(ps.reduce((s, p) => s + p.g, 0) <= 7)
    assert.ok(ps.reduce((s, p) => s + p.mem, 0) <= 8)
  }
  assert.equal(layout.length, 2)
  const cmd = migCommands('node-a', layout)
  assert.match(cmd, /nvidia-smi -i 0 -mig 1/)
  assert.match(cmd, /nvidia-smi mig -i 1 -cgi .* -C/)
})

// ---------- Simulation, chargeback, outputs ----------

test('idle timeout frees an abandoned allocation after the timeout', () => {
  const f = fleetOf(1, 24, (_, b) => b < 4 ? 0.5 : 0)
  const pls = place(f, [job({ name: 'jupyter', end: T0 + 24 * H })])
  const stats = pls.map(p => jobStats(f, p, cfg)!)
  const sim = simulate(f, pls, stats, cfg, { b0: 0, b1: f.n }, { idleTimeout: true, mig: false, fewer: false })
  // Busy 1 h, then 2 h of idle before the timeout ends it: 3 h held of 24.
  assert.equal(sim.after.alloc[0].reduce((s, x) => s + x, 0), 12)
  assert.equal(sim.freedGpuHours, 21)
  const none = simulate(f, pls, stats, cfg, { b0: 0, b1: f.n }, { idleTimeout: false, mig: false, fewer: false })
  assert.equal(none.freedGpuHours, 0, 'no policies, nothing freed')
})

test('MIG packing in the simulator puts several light jobs on one GPU and frees the rest', () => {
  const f = fleetOf(4, 6, () => 0.1, () => 6000)
  const jobs = [0, 1, 2, 3].map(g => job({ id: 'svc' + g, gpuIdx: { n1: [g] }, end: T0 + 6 * H }))
  const a = analyze(f, jobs, cfg)
  assert.ok(a.jobs.every(j => j.rec.kind === 'mig'))
  assert.equal(a.sim.allocAfter[0], 1, 'four 1g slices share one GPU')
  assert.equal(a.sim.freedGpus, 3)
  // Load is preserved: the packed GPU carries the sum of the four jobs.
  assert.ok(Math.abs(a.sim.after.load[0][0] - 0.4) < 1e-6)
})

test('dropping unused GPUs keeps the measured work on the GPUs that remain', () => {
  const f = fleetOf(8, 4, g => g < 2 ? 0.7 : 0.003)
  const a = analyze(f, [job({ gpus: 8, end: T0 + 4 * H })], cfg)
  assert.equal(a.sim.allocAfter[0], 2)
  assert.equal(a.sim.freedGpus, 6)
})

test('chargeback: cost at the class rate, team totals add up, idle cost', () => {
  const f = fleetOf(2, 10, g => g === 0 ? 0.6 : 0)
  const jobs = [job({ id: 'a', account: 'vision', gpuIdx: { n1: [0] }, end: T0 + 10 * H }), job({ id: 'b', account: 'nlp', gpuIdx: { n1: [1] }, end: T0 + 10 * H })]
  const a = analyze(f, jobs, { ...cfg, rates: { ...cfg.rates, H100: 3 } })
  const vision = a.teams.find(t => t.account === 'vision')!
  const nlp = a.teams.find(t => t.account === 'nlp')!
  assert.equal(vision.cost, 30)
  assert.equal(nlp.idleCost, 30)
  assert.equal(a.cost, vision.cost + nlp.cost)
  assert.equal(a.allocShare, 1)
  assert.equal(a.teams[0].account === 'vision' || a.teams[0].account === 'nlp', true)
})

test('month windows clip jobs to the period', () => {
  const b = new FleetBuilder(3600)
  for (let h = 0; h < 24 * 61; h++) b.add('n1', 0, Date.UTC(2026, 8, 1) + h * H, 'sm', 0.5)
  const f = b.build()
  assert.deepEqual(months(f), ['2026-09', '2026-10'])
  const w = monthWindow(f, '2026-10')
  assert.equal(w.b1 - w.b0, 31 * 24)
  const a = analyze(f, [job({ start: Date.UTC(2026, 8, 30), end: Date.UTC(2026, 9, 2) })], cfg, w)
  assert.equal(a.jobs[0].gpuHours, 24)
})

test('heatmap downsampling averages load and allocation per cell', () => {
  const f = fleetOf(1, 2, (_, b) => b < 4 ? 1 : 0)
  const a = analyze(f, [job({ end: T0 + 1 * H })], cfg)
  const h = heatmap(f, a.sim.before, a.window, 2)
  assert.equal(h.cols, 2)
  assert.equal(h.load[0], 1)
  assert.equal(h.alloc[0], 1)
  assert.equal(h.alloc[1], 0)
})

test('jobs from metric labels when no scheduler export is imported', () => {
  const f = fleetOf(2, 4, () => 0.5)
  f.tracks[0].owner = f.tracks[0].owner.map((_, b) => b < 8 ? 'ml/train-0' : null)
  f.tracks[1].owner = f.tracks[1].owner.map((_, b) => b < 8 ? 'ml/train-0' : null)
  const jobs = jobsFromLabels(f)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].gpus, 2)
  assert.equal(jobs[0].account, 'ml')
  assert.equal(jobs[0].end - jobs[0].start, 2 * H)
})

test('synthetic Helix cluster shows the expected story end to end', () => {
  const { fleet, jobs } = generate('helix')
  assert.equal(fleet.tracks.length, 64)
  const a = analyze(fleet, jobs, cfg)
  assert.ok(a.allocShare > 0.85, 'cluster looks full to the scheduler')
  assert.ok(a.meanSmAllocated < 0.6, 'but SM activity is far lower')
  assert.ok(a.byClass.idle.jobs > 10)
  assert.ok(a.jobs.some(j => j.rec.kind === 'fewer' && j.gpus === 8 && j.rec.newGpus === 2))
  assert.ok(a.sim.freedGpus > 5)
  assert.equal(a.inferredJobs, 0, 'hpc_job labels give exact GPUs')
})

test('synthetic Atlas fleet produces a MIG plan and mig-parted config', () => {
  const { fleet, jobs } = generate('atlas')
  const a = analyze(fleet, jobs, cfg)
  const plan = migPlan(fleet, a, jobs)
  assert.ok(plan.length >= 4)
  assert.ok(plan.every(p => p.layout.length <= p.gpuCount))
  const yaml = migPartedYaml(plan)
  assert.match(yaml, /mig-configs:/)
  assert.match(yaml, /nvidia.com\/mig.config=gpu-fleet-/)
})

test('exports: jobs CSV has a row per job, reaper uses the threshold, user note lists fixes', () => {
  const f = fleetOf(1, 24, (_, b) => b < 4 ? 0.3 : 0)
  const a = analyze(f, [job({ name: 'jupyter', user: 'lena', end: T0 + 24 * H })], cfg)
  const csv = parseCsv(jobsCsv(a))
  assert.equal(csv.rows.length, 2)
  assert.equal(csv.rows[1][16], 'Idle / abandoned')
  assert.match(reaperScript({ cfg, a, interactivePartitions: ['interactive'], notebookNamespaces: [], promUrl: 'http://prom:9090' }), /\[2h\]\)\) < 0.05/)
  assert.match(userNote('lena', a.jobs, 'October 2026', n => '$' + n.toFixed(0)), /1\. j1 \(jupyter\)/)
})
