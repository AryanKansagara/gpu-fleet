import { migGpu, packProfiles, pickProfile } from './mig.ts'
import { gpuClass, gpuMemMiB } from './parse.ts'
import type { Config, Fleet, GpuTrack, Job, JobClass } from './types.ts'

export const CLASS_LABEL: Record<JobClass, string> = {
  idle: 'Idle / abandoned',
  under: 'Under-utilised',
  membound: 'Memory-bound, compute-light',
  healthy: 'Healthy',
  saturated: 'Saturated',
  nodata: 'No telemetry',
}

/** Bucket window [b0, b1) of the fleet. */
export interface Window { b0: number; b1: number }

export const fullWindow = (f: Fleet): Window => ({ b0: 0, b1: f.n })

/** Buckets covering a calendar month "YYYY-MM" (UTC). */
export function monthWindow(f: Fleet, month: string): Window {
  const [y, m] = month.split('-').map(Number)
  const s = Date.UTC(y, m - 1, 1), e = Date.UTC(y, m, 1)
  const ms = f.step * 1000
  return { b0: Math.max(0, Math.ceil((s - f.t0) / ms)), b1: Math.min(f.n, Math.ceil((e - f.t0) / ms)) }
}

export function months(f: Fleet): string[] {
  if (!f.n) return []
  const out: string[] = []
  const d = new Date(f.t0)
  let y = d.getUTCFullYear(), m = d.getUTCMonth()
  const end = f.t0 + f.n * f.step * 1000
  while (Date.UTC(y, m, 1) < end) { out.push(`${y}-${String(m + 1).padStart(2, '0')}`); m++; if (m === 12) { m = 0; y++ } }
  return out
}

// ---------- Join ----------

export interface Placement {
  job: Job
  /** Track indices and the bucket range the job held each one. */
  cells: { t: number; b0: number; b1: number }[]
  /** GPU indices were guessed (lowest free), not known. */
  inferred: boolean
  /** Hosts with no telemetry at all. */
  missingHosts: string[]
}

/** Joins jobs to GPU tracks by host, GPU index and time. Known indices win; then metric owner labels; then lowest free GPUs on the host. */
export function place(f: Fleet, jobs: Job[]): Placement[] {
  const ms = f.step * 1000
  const byHost = new Map<string, number[]>()
  f.tracks.forEach((t, i) => { const l = byHost.get(t.host) ?? []; l.push(i); byHost.set(t.host, l) })
  const busyUntil = new Map<number, number>() // track -> bucket where its current inferred holder ends
  const out: Placement[] = []
  for (const job of [...jobs].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))) {
    const b0 = Math.max(0, Math.floor((job.start - f.t0) / ms))
    const b1 = Math.min(f.n, Math.ceil((job.end - f.t0) / ms))
    const p: Placement = { job, cells: [], inferred: false, missingHosts: [] }
    out.push(p)
    if (b1 <= b0) continue
    const perHost = Math.max(1, Math.round(job.gpus / job.hosts.length))
    for (const h of job.hosts) {
      const idxs = byHost.get(h)
      if (!idxs) { p.missingHosts.push(h); continue }
      let chosen: number[] = []
      const known = job.gpuIdx?.[h]
      if (known?.length) chosen = idxs.filter(i => known.includes(f.tracks[i].gpu))
      if (!chosen.length) {
        const shortId = job.id.split('/').pop()!
        chosen = idxs.filter(i => {
          const o = f.tracks[i].owner
          for (let b = b0; b < b1; b++) if (o[b] && (o[b] === job.id || o[b]!.split('/').pop() === shortId)) return true
          return false
        })
      }
      if (!chosen.length) {
        chosen = idxs.filter(i => (busyUntil.get(i) ?? 0) <= b0).slice(0, perHost)
        if (chosen.length < perHost) chosen = [...chosen, ...idxs.filter(i => !chosen.includes(i)).slice(0, perHost - chosen.length)]
        p.inferred = true
      }
      for (const t of chosen) { p.cells.push({ t, b0, b1 }); busyUntil.set(t, Math.max(busyUntil.get(t) ?? 0, b1)) }
    }
  }
  return out
}

// ---------- Per-job metrics ----------

export interface Rec {
  kind: 'release' | 'fewer' | 'mig' | 'smaller' | 'share' | 'none'
  text: string
  /** GPU-equivalents the job would hold after the change. */
  gpusAfter: number
  profile?: string
  newGpus?: number
}

export interface JobStats {
  id: string
  name?: string
  user: string
  account: string
  model: string
  gpus: number
  hours: number
  gpuHours: number
  coverage: number
  meanSm: number
  p95Sm: number
  meanTensor: number
  p95Tensor: number
  fbPeakMiB: number
  memMiB: number
  fbPeakFrac: number
  idleGpuHours: number
  timeAtZero: number
  /** 0 = every GPU equally busy; near 1 = one GPU does all the work. */
  imbalance: number
  activeGpus: number
  perGpuSm: number[]
  cls: JobClass
  notebook: boolean
  rec: Rec
  rate: number
  cost: number
  idleCost: number
  recoverableGpuHours: number
  inferred: boolean
  smProxy: boolean
}

export const p95 = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}
const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN

const NOTEBOOK = /jupyter|notebook|^nb[-_]|interactive|^bash$|^sh$|code-server|vscode|^sys\/dashboard|^spawner|^jupyterhub/i

export const rateFor = (cfg: Config, model: string | undefined) => cfg.rates[gpuClass(model)] ?? cfg.defaultRate
const ALLOWED = [1, 2, 4, 8, 16, 32, 64, 128]

export function jobStats(f: Fleet, pl: Placement, cfg: Config, w: Window = fullWindow(f)): JobStats | null {
  const cells = pl.cells.map(c => ({ ...c, b0: Math.max(c.b0, w.b0), b1: Math.min(c.b1, w.b1) })).filter(c => c.b1 > c.b0)
  const job = pl.job
  const jb0 = Math.max(w.b0, Math.floor((job.start - f.t0) / (f.step * 1000)))
  const jb1 = Math.min(w.b1, Math.ceil((job.end - f.t0) / (f.step * 1000)))
  if (jb1 <= jb0) return null
  const hStep = f.step / 3600
  const hours = (jb1 - jb0) * hStep
  const gpuHours = hours * job.gpus
  const tracks = cells.map(c => f.tracks[c.t])
  const model = job.model && gpuClass(job.model) !== 'Unknown' && tracks[0]?.model === undefined ? job.model : tracks[0]?.model ?? job.model ?? ''
  const memMiB = tracks[0]?.memMiB ?? gpuMemMiB(model) ?? 0
  const sms: number[] = [], tens: number[] = []
  let fbPeak = 0, idle = 0, zero = 0, seen = 0, slots = 0
  const perGpuSm: number[] = []
  for (const c of cells) {
    const tr = f.tracks[c.t]
    const own: number[] = []
    for (let b = c.b0; b < c.b1; b++) {
      slots++
      const s = tr.sm[b]
      if (!Number.isFinite(s)) continue
      seen++
      sms.push(s); own.push(s)
      if (Number.isFinite(tr.tensor[b])) tens.push(tr.tensor[b])
      if (Number.isFinite(tr.fb[b])) fbPeak = Math.max(fbPeak, tr.fb[b])
      if (s < cfg.idleThreshold) idle++
      if (s < 0.005) zero++
    }
    perGpuSm.push(own.length ? mean(own) : NaN)
  }
  const rate = rateFor(cfg, model)
  const base = {
    id: job.id, name: job.name, user: job.user, account: job.account, model: gpuClass(model), gpus: job.gpus, hours, gpuHours,
    rate, cost: gpuHours * rate, inferred: pl.inferred, smProxy: tracks.some(t => t.smProxy), notebook: NOTEBOOK.test(job.name ?? '') || NOTEBOOK.test(job.id.split('/').pop() ?? '') || /notebook|jupyter|interactive/i.test(job.partition ?? '') || /notebook|jupyter/i.test(job.account),
  }
  if (!seen) {
    return { ...base, coverage: 0, meanSm: NaN, p95Sm: NaN, meanTensor: NaN, p95Tensor: NaN, fbPeakMiB: NaN, memMiB, fbPeakFrac: NaN, idleGpuHours: 0, timeAtZero: NaN, imbalance: NaN, activeGpus: job.gpus, perGpuSm, cls: 'nodata', rec: { kind: 'none', text: 'No telemetry for this job’s GPUs in the window. Check the host names match between exports.', gpusAfter: job.gpus }, idleCost: 0, recoverableGpuHours: 0 }
  }
  const coverage = seen / Math.max(1, slots)
  const meanSm = mean(sms), p95Sm = p95(sms)
  const meanTensor = tens.length ? mean(tens) : NaN, p95Tensor = tens.length ? p95(tens) : NaN
  const fbPeakFrac = memMiB ? fbPeak / memMiB : NaN
  // Scale observed idle share to the job's full allocation.
  const idleGpuHours = (idle / seen) * gpuHours
  const timeAtZero = zero / seen
  const valid = perGpuSm.filter(Number.isFinite)
  const maxG = Math.max(...valid, 0)
  const imbalance = valid.length > 1 && maxG > 0 ? 1 - mean(valid) / maxG : 0
  const activeGpus = valid.length > 1 ? Math.max(1, valid.filter(x => x >= Math.max(cfg.idleThreshold, 0.25 * maxG)).length) * (job.gpus / valid.length) : job.gpus

  let cls: JobClass
  const idleRun = longestIdleHours(f, cells, cfg.idleThreshold)
  if (meanSm < cfg.idleThreshold && (timeAtZero > 0.5 || idleRun >= cfg.idleTimeoutHours)) cls = 'idle'
  else if (meanSm >= cfg.saturatedThreshold) cls = 'saturated'
  else if (p95Sm < cfg.lightThreshold && job.gpus <= 2 && imbalance < 0.5) cls = 'membound'
  else if (meanSm < cfg.healthyThreshold || imbalance >= 0.5) cls = 'under'
  else cls = 'healthy'

  const rec = recommend({ cls, gpus: job.gpus, activeGpus, p95Sm, meanSm, fbPeak, memMiB, model, notebook: base.notebook, idleRun }, cfg)
  return {
    ...base, coverage, meanSm, p95Sm, meanTensor, p95Tensor, fbPeakMiB: fbPeak, memMiB, fbPeakFrac, idleGpuHours, timeAtZero, imbalance, activeGpus, perGpuSm, cls, rec,
    idleCost: idleGpuHours * rate, recoverableGpuHours: Math.max(0, job.gpus - rec.gpusAfter) * hours,
  }
}

function longestIdleHours(f: Fleet, cells: { t: number; b0: number; b1: number }[], thr: number): number {
  if (!cells.length) return 0
  const b0 = Math.min(...cells.map(c => c.b0)), b1 = Math.max(...cells.map(c => c.b1))
  let run = 0, best = 0
  for (let b = b0; b < b1; b++) {
    const idle = cells.every(c => { const s = f.tracks[c.t].sm[b]; return !Number.isFinite(s) || s < thr })
    run = idle ? run + 1 : 0
    best = Math.max(best, run)
  }
  return best * f.step / 3600
}

interface RecIn { cls: JobClass; gpus: number; activeGpus: number; p95Sm: number; meanSm: number; fbPeak: number; memMiB: number; model: string; notebook: boolean; idleRun: number }

export function recommend(x: RecIn, cfg: Config): Rec {
  if (x.cls === 'idle') return { kind: 'release', gpusAfter: 0, text: x.notebook ? `Idle notebook: no GPU work for ${Math.round(x.idleRun)}h in a row. An idle culler or ${cfg.idleTimeoutHours}h timeout would have released all ${x.gpus} GPU${x.gpus > 1 ? 's' : ''}.` : `Allocated but idle (mean SM ${(x.meanSm * 100).toFixed(1)}%). Cancel it; an idle timeout of ${cfg.idleTimeoutHours}h would have freed ${x.gpus} GPU${x.gpus > 1 ? 's' : ''}.` }
  if (x.cls === 'saturated') return { kind: 'none', gpusAfter: x.gpus, text: 'Saturated. Leave it alone; if it queues, it is the case for more or faster GPUs.' }
  if (x.activeGpus < x.gpus - 0.01) {
    const n = ALLOWED.find(a => a >= Math.ceil(x.activeGpus - 1e-9)) ?? x.gpus
    if (n < x.gpus) return { kind: 'fewer', newGpus: n, gpusAfter: n, text: `Only ${fmtCount(x.activeGpus)} of ${x.gpus} GPUs do work. Request ${n} GPU${n > 1 ? 's' : ''} (check the launcher: torchrun --nproc_per_node, CUDA_VISIBLE_DEVICES, or a DataParallel default).` }
  }
  if (x.cls === 'membound' || x.cls === 'under') {
    const per = x.gpus
    const mg = migGpu(x.model, x.memMiB)
    if (mg) {
      const prof = pickProfile(mg, x.fbPeak, x.p95Sm, cfg.memHeadroom)
      if (prof) {
        const g = mg.profiles.find(p => p.name === prof.name)!.g
        return { kind: 'mig', profile: prof.name, gpusAfter: per * g / mg.slices, text: `Peak memory ${(x.fbPeak / 1024).toFixed(1)} GiB and p95 SM ${(x.p95Sm * 100).toFixed(0)}% fit a ${prof.name} MIG slice${per > 1 ? ` per GPU` : ''}, so ${Math.floor(mg.slices / g)} jobs like this share one ${mg.label}.` }
      }
    } else {
      const smaller = smallerClass(x.fbPeak * (1 + cfg.memHeadroom), x.model)
      if (smaller && x.p95Sm < cfg.lightThreshold) return { kind: 'smaller', gpusAfter: per * (rateFor(cfg, smaller) / rateFor(cfg, x.model)), text: `Fits a ${smaller} (${(x.fbPeak / 1024).toFixed(1)} GiB peak, p95 SM ${(x.p95Sm * 100).toFixed(0)}%). Move it to a cheaper class.` }
    }
    if (x.cls === 'under') return { kind: 'share', gpusAfter: x.gpus, text: `Bursty: mean SM ${(x.meanSm * 100).toFixed(0)}% but p95 ${(x.p95Sm * 100).toFixed(0)}%. Look at the input pipeline (dataloader workers, CPU preprocessing) before cutting GPUs.` }
  }
  return { kind: 'none', gpusAfter: x.gpus, text: 'Healthy. No change.' }
}

const fmtCount = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1)

const CLASSES_BY_MEM: [string, number][] = [['T4', 16], ['L4', 24], ['A10', 24], ['L40S', 48]]
function smallerClass(needMiB: number, model: string): string | null {
  const cur = gpuMemMiB(model) ?? Infinity
  const c = CLASSES_BY_MEM.find(([, gb]) => gb * 1024 >= needMiB && gb * 1024 < cur)
  return c ? c[0] : null
}

// ---------- Fleet analysis ----------

export interface TeamRow { account: string; jobs: number; users: number; gpuHours: number; usedGpuHours: number; idleGpuHours: number; cost: number; idleCost: number; meanSm: number; recoverableGpus: number }
export interface UserRow { user: string; account: string; jobs: number; gpuHours: number; idleGpuHours: number; cost: number; idleCost: number; meanSm: number; top: JobStats[] }

export interface Analysis {
  window: Window
  hours: number
  gpus: number
  jobs: JobStats[]
  teams: TeamRow[]
  users: UserRow[]
  /** GPU-hours the fleet could supply in the window. */
  capacityGpuHours: number
  allocGpuHours: number
  allocShare: number
  meanSmAllocated: number
  meanSmFleet: number
  idleAllocGpuHours: number
  cost: number
  idleCost: number
  byClass: Record<JobClass, { jobs: number; gpuHours: number }>
  sim: SimResult
  inferredJobs: number
  smProxy: boolean
}

export function analyze(f: Fleet, jobs: Job[], cfg: Config, w: Window = fullWindow(f)): Analysis {
  const pls = place(f, jobs)
  const stats: JobStats[] = []
  const plOf = new Map<string, Placement>()
  for (const pl of pls) { const s = jobStats(f, pl, cfg, w); if (s) { stats.push(s); plOf.set(s.id, pl) } }
  const hours = (w.b1 - w.b0) * f.step / 3600
  const capacityGpuHours = hours * f.tracks.length
  const allocGpuHours = stats.reduce((s, j) => s + j.gpuHours, 0)
  const withData = stats.filter(j => j.cls !== 'nodata')
  const usedGpuHours = withData.reduce((s, j) => s + j.meanSm * j.gpuHours, 0)
  const byClass = Object.fromEntries((['idle', 'under', 'membound', 'healthy', 'saturated', 'nodata'] as JobClass[]).map(c => [c, { jobs: 0, gpuHours: 0 }])) as Analysis['byClass']
  for (const j of stats) { byClass[j.cls].jobs++; byClass[j.cls].gpuHours += j.gpuHours }

  const sim = simulate(f, pls, stats, cfg, w)
  const recByJob = new Map(sim.perJob.map(r => [r.id, r.recoveredGpuHours]))

  const teams = new Map<string, TeamRow & { u: Set<string>; smw: number }>()
  for (const j of stats) {
    const t = teams.get(j.account) ?? { account: j.account, jobs: 0, users: 0, u: new Set(), gpuHours: 0, usedGpuHours: 0, idleGpuHours: 0, cost: 0, idleCost: 0, meanSm: 0, smw: 0, recoverableGpus: 0 }
    t.jobs++; t.u.add(j.user); t.gpuHours += j.gpuHours; t.idleGpuHours += j.idleGpuHours; t.cost += j.cost; t.idleCost += j.idleCost
    if (Number.isFinite(j.meanSm)) { t.usedGpuHours += j.meanSm * j.gpuHours; t.smw += j.gpuHours }
    t.recoverableGpus += (recByJob.get(j.id) ?? 0) / Math.max(hours, 1e-9)
    teams.set(j.account, t)
  }
  const users = new Map<string, UserRow & { smw: number; used: number }>()
  for (const j of stats) {
    const k = `${j.account}\u0000${j.user}`
    const u = users.get(k) ?? { user: j.user, account: j.account, jobs: 0, gpuHours: 0, idleGpuHours: 0, cost: 0, idleCost: 0, meanSm: 0, top: [], smw: 0, used: 0 }
    u.jobs++; u.gpuHours += j.gpuHours; u.idleGpuHours += j.idleGpuHours; u.cost += j.cost; u.idleCost += j.idleCost
    if (Number.isFinite(j.meanSm)) { u.used += j.meanSm * j.gpuHours; u.smw += j.gpuHours }
    u.top.push(j)
    users.set(k, u)
  }
  const fleetSm: number[] = []
  for (const t of f.tracks) for (let b = w.b0; b < w.b1; b++) if (Number.isFinite(t.sm[b])) fleetSm.push(t.sm[b])
  return {
    window: w, hours, gpus: f.tracks.length, jobs: stats.sort((a, b) => wasteOf(b) - wasteOf(a)),
    teams: [...teams.values()].map(({ u, smw, ...t }) => ({ ...t, users: u.size, meanSm: smw ? t.usedGpuHours / smw : NaN })).sort((a, b) => b.cost - a.cost),
    users: [...users.values()].map(({ smw, used, top, ...u }) => ({ ...u, meanSm: smw ? used / smw : NaN, top: top.sort((a, b) => wasteOf(b) - wasteOf(a)).slice(0, 5) })).sort((a, b) => b.idleCost - a.idleCost),
    capacityGpuHours, allocGpuHours, allocShare: capacityGpuHours ? allocGpuHours / capacityGpuHours : 0,
    meanSmAllocated: withData.length ? usedGpuHours / withData.reduce((s, j) => s + j.gpuHours, 0) : NaN,
    meanSmFleet: mean(fleetSm),
    idleAllocGpuHours: stats.reduce((s, j) => s + j.idleGpuHours, 0),
    cost: stats.reduce((s, j) => s + j.cost, 0), idleCost: stats.reduce((s, j) => s + j.idleCost, 0),
    byClass, sim, inferredJobs: stats.filter(j => j.inferred).length, smProxy: f.tracks.some(t => t.smProxy),
  }
}

/** Waste in GPU-hours worth recovering: idle time plus what right-sizing frees. */
export const wasteOf = (j: JobStats) => Math.max(j.idleGpuHours, j.recoverableGpuHours) * j.rate

// ---------- Policy simulation ----------

export interface SimResult {
  /** Per track, per bucket in the window: occupancy (0 free, 1 allocated) and SM load. */
  before: { alloc: Uint8Array[]; load: Float32Array[] }
  after: { alloc: Uint8Array[]; load: Float32Array[] }
  allocBefore: number[]
  allocAfter: number[]
  /** Average whole GPUs freed across the window. */
  freedGpus: number
  peakFreed: number
  freedGpuHours: number
  perJob: { id: string; recoveredGpuHours: number }[]
}

interface Item { job: string; share: number; load: number; order: number }

/**
 * Replays the window with the chosen policies: idle jobs end after the timeout, oversized jobs drop GPUs that did no work,
 * MIG candidates take a slice instead of a whole GPU. Work stays on its node; each bucket is re-packed first-fit onto the lowest GPU indices.
 */
export function simulate(f: Fleet, pls: Placement[], stats: JobStats[], cfg: Config, w: Window, applied = cfg.applied): SimResult {
  const n = w.b1 - w.b0
  const T = f.tracks.length
  const mk = () => ({ alloc: Array.from({ length: T }, () => new Uint8Array(n)), load: Array.from({ length: T }, () => new Float32Array(n)) })
  const before = mk(), after = mk()
  const statOf = new Map(stats.map(s => [s.id, s]))
  const hostTracks = new Map<string, number[]>()
  f.tracks.forEach((t, i) => { const l = hostTracks.get(t.host) ?? []; l.push(i); hostTracks.set(t.host, l) })
  // host -> bucket -> items
  const demand = new Map<string, Item[][]>()
  const perJob = new Map<string, number>()
  const timeoutB = Math.max(1, Math.round(cfg.idleTimeoutHours * 3600 / f.step))
  const val = (tr: GpuTrack, b: number) => { const s = tr.sm[b]; return Number.isFinite(s) ? s : 0 }

  pls.forEach((pl, order) => {
    const st = statOf.get(pl.job.id)
    const cells = pl.cells.map(c => ({ ...c, b0: Math.max(c.b0, w.b0), b1: Math.min(c.b1, w.b1) })).filter(c => c.b1 > c.b0)
    if (!cells.length) return
    for (const c of cells) for (let b = c.b0; b < c.b1; b++) { before.alloc[c.t][b - w.b0] = 1; before.load[c.t][b - w.b0] = val(f.tracks[c.t], b) }
    if (!st || st.cls === 'nodata') {
      for (const c of cells) addItems(c.t, c.b0, c.b1, 1)
      return
    }
    // Idle timeout: the job ends once every GPU has been idle for the timeout.
    let end = Math.max(...cells.map(c => c.b1))
    if (applied.idleTimeout) {
      const s0 = Math.min(...cells.map(c => c.b0))
      let run = 0
      for (let b = s0; b < end; b++) {
        const idle = cells.every(c => b < c.b0 || b >= c.b1 || val(f.tracks[c.t], b) < cfg.idleThreshold)
        run = idle ? run + 1 : 0
        if (run >= timeoutB) { end = b + 1; break }
      }
    }
    let keep = cells
    if (applied.fewer && st.rec.kind === 'fewer' && st.rec.newGpus) {
      const ranked = cells.map((c, i) => ({ c, i, m: st.perGpuSm[i] ?? 0 })).sort((a, b) => (b.m || 0) - (a.m || 0))
      keep = ranked.slice(0, st.rec.newGpus).map(r => r.c)
    }
    const share = applied.mig && st.rec.kind === 'mig' ? st.rec.gpusAfter / Math.max(1, keep.length) : 1
    // Load of dropped GPUs moves onto the kept ones so no measured work disappears.
    const dropped = cells.filter(c => !keep.includes(c))
    for (const c of keep) addItems(c.t, c.b0, Math.min(c.b1, end), share, dropped)
    function addItems(t: number, b0: number, b1: number, sh: number, extra: typeof cells = []) {
      const host = f.tracks[t].host
      let grid = demand.get(host)
      if (!grid) { grid = Array.from({ length: n }, () => []); demand.set(host, grid) }
      for (let b = b0; b < b1; b++) {
        let load = val(f.tracks[t], b)
        for (const d of extra) if (b >= d.b0 && b < d.b1) load += val(f.tracks[d.t], b) / Math.max(1, keep.length)
        grid[b - w.b0].push({ job: pl.job.id, share: sh, load, order })
      }
    }
    const held = cells.reduce((s, c) => s + (c.b1 - c.b0), 0)
    const kept = keep.reduce((s, c) => s + Math.max(0, Math.min(c.b1, end) - c.b0) * share, 0)
    perJob.set(pl.job.id, (perJob.get(pl.job.id) ?? 0) + (held - kept) * f.step / 3600)
  })

  for (const [host, grid] of demand) {
    const idxs = hostTracks.get(host)!
    for (let b = 0; b < n; b++) {
      const items = grid[b]
      if (!items.length) continue
      items.sort((x, y) => y.share - x.share || x.order - y.order)
      const used = new Float64Array(idxs.length)
      for (const it of items) {
        let k = 0
        while (k < idxs.length - 1 && used[k] + it.share > 1 + 1e-9) k++
        used[k] += it.share
        const t = idxs[k]
        after.alloc[t][b] = 1
        after.load[t][b] = Math.min(1, after.load[t][b] + it.load)
      }
    }
  }
  const count = (g: Uint8Array[]) => { const out = new Array<number>(n).fill(0); for (const row of g) for (let b = 0; b < n; b++) out[b] += row[b]; return out }
  const allocBefore = count(before.alloc), allocAfter = count(after.alloc)
  const freed = allocBefore.map((x, i) => Math.max(0, x - allocAfter[i]))
  const freedGpuHours = freed.reduce((s, x) => s + x, 0) * f.step / 3600
  return {
    before, after, allocBefore, allocAfter, freedGpus: n ? freed.reduce((s, x) => s + x, 0) / n : 0, peakFreed: Math.max(0, ...freed), freedGpuHours,
    perJob: [...perJob].map(([id, recoveredGpuHours]) => ({ id, recoveredGpuHours })),
  }
}

// ---------- Heatmap ----------

export interface Heat { rows: { key: string; host: string; gpu: number }[]; cols: number; t0: number; colMs: number; load: Float32Array; alloc: Float32Array }

/** Downsamples a simulation grid to `cols` columns: mean SM load and the share of time allocated per cell. */
export function heatmap(f: Fleet, grid: { alloc: Uint8Array[]; load: Float32Array[] }, w: Window, cols = 96): Heat {
  const n = w.b1 - w.b0
  cols = Math.max(1, Math.min(cols, n))
  const T = f.tracks.length
  const load = new Float32Array(T * cols), alloc = new Float32Array(T * cols)
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * n / cols), b = Math.floor((c + 1) * n / cols)
      let l = 0, al = 0
      for (let i = a; i < b; i++) { l += grid.load[t][i]; al += grid.alloc[t][i] }
      load[t * cols + c] = l / Math.max(1, b - a)
      alloc[t * cols + c] = al / Math.max(1, b - a)
    }
  }
  return { rows: f.tracks.map(t => ({ key: t.key, host: t.host, gpu: t.gpu })), cols, t0: f.t0 + w.b0 * f.step * 1000, colMs: n * f.step * 1000 / cols, load, alloc }
}

// ---------- MIG plan per node ----------

export interface NodePlan { host: string; gpuLabel: string; gpuCount: number; jobs: string[]; layout: string[][]; gpusFreed: number }

/** Peak concurrent MIG-candidate demand on each node, packed into per-GPU layouts. */
export function migPlan(f: Fleet, a: Analysis, jobs: Job[]): NodePlan[] {
  const migJobs = a.jobs.filter(j => j.rec.kind === 'mig' && j.rec.profile)
  if (!migJobs.length) return []
  const pls = place(f, jobs.filter(j => migJobs.some(m => m.id === j.id)))
  const byHost = new Map<string, { b0: number; b1: number; profile: string; id: string; n: number }[]>()
  for (const pl of pls) {
    const st = migJobs.find(m => m.id === pl.job.id)!
    for (const c of pl.cells) {
      const host = f.tracks[c.t].host
      const l = byHost.get(host) ?? []
      l.push({ b0: Math.max(c.b0, a.window.b0), b1: Math.min(c.b1, a.window.b1), profile: st.rec.profile!, id: st.id, n: 1 })
      byHost.set(host, l)
    }
  }
  const out: NodePlan[] = []
  for (const [host, list] of byHost) {
    const tr = f.tracks.find(t => t.host === host)!
    const mg = migGpu(tr.model, tr.memMiB)
    if (!mg) continue
    // Find the bucket with the most compute slices in use.
    let best: typeof list = [], bestG = -1
    const edges = [...new Set(list.map(x => x.b0))]
    for (const b of edges) {
      const live = list.filter(x => x.b0 <= b && b < x.b1)
      const g = live.reduce((s, x) => s + (mg.profiles.find(p => p.name === x.profile)?.g ?? 0), 0)
      if (g > bestG) { bestG = g; best = live }
    }
    const layout = packProfiles(mg, best.map(x => x.profile))
    out.push({ host, gpuLabel: mg.label, gpuCount: f.tracks.filter(t => t.host === host).length, jobs: [...new Set(list.map(x => x.id))], layout, gpusFreed: best.length - layout.length })
  }
  return out.sort((x, y) => x.host.localeCompare(y.host, undefined, { numeric: true }))
}

// ---------- Snapshots ----------

export interface Snapshot {
  id: string
  period: string
  label: string
  at: number
  gpus: number
  hours: number
  allocShare: number
  meanSmAllocated: number
  idleShare: number
  allocGpuHours: number
  idleAllocGpuHours: number
  cost: number
  idleCost: number
  recoverableGpus: number
  byClass: Record<string, number>
  teams: { account: string; gpuHours: number; cost: number; meanSm: number; idleGpuHours: number }[]
  note?: string
}

export function snapshot(a: Analysis, period: string, id: string, label: string, note?: string): Snapshot {
  return {
    id, period, label, at: Date.now(), gpus: a.gpus, hours: a.hours, allocShare: a.allocShare, meanSmAllocated: a.meanSmAllocated,
    idleShare: a.allocGpuHours ? a.idleAllocGpuHours / a.allocGpuHours : 0, allocGpuHours: a.allocGpuHours, idleAllocGpuHours: a.idleAllocGpuHours,
    cost: a.cost, idleCost: a.idleCost, recoverableGpus: a.sim.freedGpus,
    byClass: Object.fromEntries(Object.entries(a.byClass).map(([k, v]) => [k, v.gpuHours])),
    teams: a.teams.map(t => ({ account: t.account, gpuHours: t.gpuHours, cost: t.cost, meanSm: t.meanSm, idleGpuHours: t.idleGpuHours })),
    ...(note ? { note } : {}),
  }
}
