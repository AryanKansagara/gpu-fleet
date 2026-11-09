// Two synthetic clusters. Every number here is generated; none of it is real customer data.
import type { Fleet, GpuTrack, Job } from './types.ts'

export interface SampleDef { id: string; name: string; blurb: string; kind: 'slurm' | 'k8s' }

export const SAMPLES: SampleDef[] = [
  { id: 'helix', name: 'Helix research cluster (synthetic)', blurb: '64× H100 on Slurm. Jupyter sessions holding GPUs for days, and 8-GPU fine-tunes that only use 2.', kind: 'slurm' },
  { id: 'atlas', name: 'Atlas inference fleet (synthetic)', blurb: '40 GPUs on Kubernetes. Small models on whole A100s and H100s: a textbook MIG case.', kind: 'k8s' },
]

export const SAMPLE_MONTH = '2026-10'
export const SAMPLE_HISTORY = ['2026-08', '2026-09']

function rng(seed: number) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 }

type Kind = 'pretrain' | 'oversized' | 'notebook' | 'eval' | 'bursty' | 'train' | 'serve-small' | 'serve-llm'
interface Gen { job: Job; kind: Kind; scale: number; mem: number }

const STEP = 900

function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  return { start: Date.UTC(y, m - 1, 1), end: Date.UTC(y, m, 1) }
}

/** Per-bucket behaviour for one GPU of a job. g = GPU index within the job, k = buckets since start. */
function behave(gen: Gen, g: number, k: number, hourOfDay: number, r: () => number): { sm: number; tensor: number; fb: number } {
  const n = () => (r() - 0.5) * 2
  const diurnal = 0.55 + 0.45 * Math.sin(((hourOfDay - 9) / 24) * Math.PI * 2)
  switch (gen.kind) {
    case 'pretrain': { const sm = clamp(0.78 * gen.scale + n() * 0.06); return { sm, tensor: sm * 0.62, fb: gen.mem * (0.96 + n() * 0.02) } }
    case 'train': { const sm = clamp(0.62 * gen.scale + n() * 0.08); return { sm, tensor: sm * 0.5, fb: gen.mem * (0.9 + n() * 0.05) } }
    case 'oversized': {
      if (g < 2) { const sm = clamp(0.66 + n() * 0.08); return { sm, tensor: sm * 0.5, fb: gen.mem } }
      return { sm: clamp(0.002 + r() * 0.004), tensor: 0, fb: 520 }
    }
    case 'notebook': {
      const activeFor = 4 + (hash(gen.job.id) % 8) // first 1-3 hours
      if (k < activeFor && r() > 0.3) { const sm = clamp(0.32 + n() * 0.2); return { sm, tensor: sm * 0.3, fb: gen.mem } }
      return { sm: r() < 0.02 ? 0.05 : 0, tensor: 0, fb: gen.mem }
    }
    case 'eval': { const sm = clamp(0.13 * gen.scale + n() * 0.06); return { sm, tensor: sm * 0.4, fb: gen.mem * (0.85 + r() * 0.15) } }
    case 'bursty': { const burst = (k % 8) < 2; const sm = clamp((burst ? 0.75 : 0.12) + n() * 0.08); return { sm, tensor: sm * 0.45, fb: gen.mem } }
    case 'serve-small': { const sm = clamp(0.12 * gen.scale * diurnal * 1.4 + n() * 0.03); return { sm, tensor: sm * 0.5, fb: gen.mem * (0.95 + r() * 0.05) } }
    case 'serve-llm': { const sm = clamp(0.5 * gen.scale * diurnal * 1.3 + n() * 0.06); return { sm, tensor: sm * 0.55, fb: gen.mem } }
  }
}

function buildFleet(hosts: { host: string; gpus: number; model: string; memMiB: number }[], start: number, end: number, gens: Gen[], seed: number, idx: Map<string, Record<string, number[]>>, labelOwner: boolean): Fleet {
  const n = Math.round((end - start) / 1000 / STEP)
  const r = rng(seed ^ 0x9e3779b9)
  const tracks: GpuTrack[] = []
  const trackOf = new Map<string, GpuTrack>()
  for (const h of hosts) for (let g = 0; g < h.gpus; g++) {
    const tr: GpuTrack = {
      key: `${h.host}:${g}`, host: h.host, gpu: g, model: h.model, memMiB: h.memMiB, uuid: `GPU-${(hash(h.host + g) >>> 0).toString(16).padStart(8, '0')}-synthetic`,
      sm: new Array(n).fill(0), tensor: new Array(n).fill(0), fb: new Array(n).fill(0), power: new Array(n).fill(0), owner: new Array(n).fill(null),
    }
    tracks.push(tr); trackOf.set(tr.key, tr)
  }
  for (const gen of gens) {
    const map = idx.get(gen.job.id)!
    let gi = 0
    for (const [host, list] of Object.entries(map)) for (const gpu of list) {
      const tr = trackOf.get(`${host}:${gpu}`)!
      const b0 = Math.max(0, Math.floor((gen.job.start - start) / 1000 / STEP)), b1 = Math.min(n, Math.ceil((gen.job.end - start) / 1000 / STEP))
      for (let b = b0; b < b1; b++) {
        const hod = new Date(start + b * STEP * 1000).getUTCHours()
        const v = behave(gen, gi, b - b0, hod, r)
        tr.sm[b] = v.sm; tr.tensor[b] = v.tensor; tr.fb[b] = Math.round(v.fb)
        if (labelOwner) tr.owner[b] = gen.job.id
      }
      gi++
    }
  }
  const tdp = (m: string) => /H100/.test(m) ? 700 : 400
  for (const tr of tracks) for (let b = 0; b < n; b++) tr.power[b] = Math.round(65 + tr.sm[b] * (tdp(tr.model ?? '') - 90) + r() * 10)
  return { t0: start, step: STEP, n, tracks }
}

// ---------- Helix: Slurm research cluster ----------

const HELIX_TEAMS: { account: string; users: string[]; mix: [Kind, number][] }[] = [
  { account: 'llm-pretrain', users: ['ana.ruiz', 'bo.chen'], mix: [['pretrain', 3], ['train', 1]] },
  { account: 'nlp-finetune', users: ['dmitri.k', 'priya.s', 'yuki.t'], mix: [['oversized', 3], ['train', 2], ['notebook', 1]] },
  { account: 'vision', users: ['lena.m', 'omar.h', 'chloe.b'], mix: [['notebook', 2], ['train', 3], ['eval', 1]] },
  { account: 'speech', users: ['kai.t', 'nora.l'], mix: [['eval', 4], ['train', 1], ['notebook', 1]] },
  { account: 'rl', users: ['sam.w', 'ines.d'], mix: [['bursty', 3], ['train', 1]] },
]

const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]
function pickWeighted<T>(r: () => number, xs: [T, number][]): T {
  const tot = xs.reduce((s, x) => s + x[1], 0)
  let u = r() * tot
  for (const [v, w] of xs) { if ((u -= w) <= 0) return v }
  return xs[0][0]
}

function helix(month: string, variant = 0): { fleet: Fleet; jobs: Job[] } {
  const { start, end } = monthRange(month)
  const r = rng(hash('helix' + month) + variant)
  const hosts = Array.from({ length: 8 }, (_, i) => ({ host: `h100-${String(i + 1).padStart(2, '0')}`, gpus: 8, model: 'NVIDIA H100 80GB HBM3', memMiB: 81559 }))
  const freeAt = new Map<string, number>() // host:gpu -> time free
  hosts.forEach(h => { for (let g = 0; g < 8; g++) freeAt.set(`${h.host}:${g}`, start - r() * 86400000 * 0.5) })
  const gens: Gen[] = []
  const idx = new Map<string, Record<string, number[]>>()
  let id = 4_810_000 + Math.floor(r() * 9000) + (variant * 37_000)
  // Keep trying to submit jobs at 30-minute ticks until the month ends; the cluster stays near-full.
  for (let t = start - 2 * 86400000; t < end; t += 1800000) {
    for (let tries = 0; tries < 3; tries++) {
      const team = pickWeighted(r, HELIX_TEAMS.map(x => [x, x.account === 'llm-pretrain' ? 1.6 : 1] as [typeof x, number]))
      const kind = pickWeighted(r, team.mix)
      const size = kind === 'pretrain' ? 16 : kind === 'oversized' ? 8 : kind === 'bursty' ? 4 : kind === 'notebook' ? (r() < 0.3 ? 2 : 1) : kind === 'eval' ? 1 : pick(r, [1, 2, 4, 8])
      const hours = kind === 'pretrain' ? 48 + r() * 72 : kind === 'notebook' ? 10 + r() * 50 : kind === 'oversized' ? 10 + r() * 30 : kind === 'eval' ? 3 + r() * 9 : 6 + r() * 30
      const perHost = Math.min(8, size)
      const nHosts = size / perHost
      const pool = kind === 'pretrain' || kind === 'oversized' || size === 8 ? hosts.slice(0, 5) : hosts.slice(5)
      const cand = pool.map(h => ({ h, free: Array.from({ length: 8 }, (_, g) => g).filter(g => freeAt.get(`${h.host}:${g}`)! <= t) }))
        .filter(c => c.free.length >= perHost)
        .sort((a, b) => a.free.length - b.free.length) // best fit, like cons_tres
      if (kind !== 'pretrain' && kind !== 'oversized' && r() < 0.35) continue // pacing: not every tick has a submission
      if (cand.length < nHosts) continue
      const chosen = cand.slice(0, nHosts)
      const s = t + Math.floor(r() * 4) * 300000
      const e = s + hours * 3600000
      const map: Record<string, number[]> = {}
      for (const c of chosen) { map[c.h.host] = c.free.slice(0, perHost); for (const g of map[c.h.host]) freeAt.set(`${c.h.host}:${g}`, e) }
      const user = pick(r, team.users)
      const jid = String(id++)
      const name = kind === 'notebook' ? pick(r, ['jupyter', 'sys/dashboard/jupyter', 'interactive']) : kind === 'pretrain' ? `pt-7b-${pick(r, ['mix3', 'code', 'long'])}` : kind === 'oversized' ? `ft-${pick(r, ['llama', 'mistral', 'qwen'])}-lora` : kind === 'eval' ? `eval-${pick(r, ['asr', 'wer', 'tts'])}` : kind === 'bursty' ? `ppo-${pick(r, ['atari', 'mujoco'])}` : `train-${pick(r, ['vit', 'resnet', 'clip', 'bert'])}`
      const job: Job = {
        id: jid, name, user, account: team.account, partition: kind === 'notebook' ? 'interactive' : 'gpu', state: e > end ? 'RUNNING' : 'COMPLETED',
        start: s, end: Math.min(e, end), gpus: size, hosts: Object.keys(map), model: 'h100', source: 'slurm',
      }
      idx.set(jid, map)
      const mem = kind === 'pretrain' ? 76000 : kind === 'oversized' ? 52000 : kind === 'notebook' ? 6000 + r() * 22000 : kind === 'eval' ? 7000 + r() * 9000 : kind === 'bursty' ? 14000 : 30000 + r() * 40000
      gens.push({ job, kind, scale: kind === 'eval' ? 0.7 + r() * 0.6 : 0.85 + r() * 0.25, mem })
      if (s >= end) break
    }
  }
  const live = gens.filter(g => g.job.end > start && g.job.start < end)
  const fleet = buildFleet(hosts, start, end, live, hash(month) + variant, idx, true)
  for (const g of live) g.job.start = Math.max(g.job.start, start - 0) // keep true start; the window clips
  return { fleet, jobs: live.map(g => g.job) }
}

// ---------- Atlas: Kubernetes inference fleet ----------

function atlas(month: string, variant = 0): { fleet: Fleet; jobs: Job[] } {
  const { start, end } = monthRange(month)
  const r = rng(hash('atlas' + month) + variant)
  const hosts = [
    ...Array.from({ length: 2 }, (_, i) => ({ host: `inf-h100-${i + 1}`, gpus: 8, model: 'NVIDIA H100 80GB HBM3', memMiB: 81559 })),
    ...Array.from({ length: 6 }, (_, i) => ({ host: `inf-a100-${i + 1}`, gpus: 4, model: 'NVIDIA A100-SXM4-80GB', memMiB: 81920 })),
  ]
  const services: { ns: string; app: string; kind: Kind; replicas: number; mem: number; users: string; scale: number; gpus?: number }[] = [
    { ns: 'search', app: 'embed-bge', kind: 'serve-small', replicas: 8, mem: 9000, users: 'search-oncall', scale: 0.9 },
    { ns: 'ads', app: 'ranker-v7', kind: 'serve-small', replicas: 8, mem: 7000, users: 'ads-ml', scale: 1.1 },
    { ns: 'recsys', app: 'two-tower', kind: 'serve-small', replicas: 6, mem: 17000, users: 'recsys-ml', scale: 1.3 },
    { ns: 'assistant', app: 'vllm-llama-70b', kind: 'serve-llm', replicas: 3, mem: 74000, users: 'assistant-team', scale: 1.15, gpus: 2 },
    { ns: 'assistant', app: 'vllm-8b', kind: 'serve-llm', replicas: 2, mem: 72000, users: 'assistant-team', scale: 0.55 },
    { ns: 'safety', app: 'guard-classifier', kind: 'serve-small', replicas: 4, mem: 5000, users: 'trust-safety', scale: 0.7 },
  ]
  const free = new Map<string, number[]>(hosts.map(h => [h.host, Array.from({ length: h.gpus }, (_, g) => g)]))
  const gens: Gen[] = []
  const idx = new Map<string, Record<string, number[]>>()
  const place = (n: number, prefer: RegExp) => {
    const hs = hosts.filter(h => prefer.test(h.host)).concat(hosts.filter(h => !prefer.test(h.host)))
    for (const h of hs) { const f = free.get(h.host)!; if (f.length >= n) return { host: h.host, gpus: f.splice(0, n) } }
    return null
  }
  const suffix = () => Math.floor(r() * 0xfffff).toString(36).padStart(4, 'x') + '-' + Math.floor(r() * 0xffff).toString(36)
  for (const s of services) for (let i = 0; i < s.replicas; i++) {
    const n = s.gpus ?? 1
    const at = place(n, s.kind === 'serve-llm' ? /h100/ : /a100/)
    if (!at) continue
    const id = `${s.ns}/${s.app}-${suffix()}`
    const st = start - Math.floor(r() * 20) * 86400000
    const job: Job = { id, name: id.split('/')[1], user: s.users, account: s.ns, state: 'Running', start: st, end, gpus: n, hosts: [at.host], source: 'k8s' }
    idx.set(id, { [at.host]: at.gpus })
    gens.push({ job, kind: s.kind, scale: s.scale * (0.85 + r() * 0.3), mem: s.mem })
  }
  // Kubeflow notebooks: a few come and go, most sit idle.
  for (let i = 0; i < 7; i++) {
    const at = place(1, /a100|h100/)
    if (!at) break
    const user = pick(r, ['mei.l', 'raj.p', 'tom.k', 'ola.n', 'zoe.f'])
    const id = `notebooks/${user.replace('.', '-')}-nb-${i}-0`
    const st = start + Math.floor(r() * 12) * 86400000
    const job: Job = { id, name: `${user.replace('.', '-')}-nb-${i}`, user, account: 'notebooks', state: 'Running', start: st, end: Math.min(end, st + (3 + r() * 14) * 86400000), gpus: 1, hosts: [at.host], source: 'k8s' }
    idx.set(id, { [at.host]: at.gpus })
    gens.push({ job, kind: 'notebook', scale: 1, mem: 4000 + r() * 12000 })
  }
  const fleet = buildFleet(hosts, start, end, gens, hash(month) + variant + 7, idx, true)
  return { fleet, jobs: gens.map(g => g.job) }
}

export function generate(sampleId: string, month = SAMPLE_MONTH): { fleet: Fleet; jobs: Job[] } {
  const variant = month === SAMPLE_MONTH ? 0 : SAMPLE_HISTORY.indexOf(month) + 1
  return sampleId === 'atlas' ? atlas(month, variant) : helix(month, variant)
}
