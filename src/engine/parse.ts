import type { Fleet, GpuTrack, Issue, Job } from './types.ts'

// ---------- CSV ----------

/** RFC 4180-ish parser. Sniffs comma, tab, semicolon, pipe, or runs of spaces (kubectl custom-columns). Keeps source line numbers. */
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  if (delim === ' ') {
    const rows: string[][] = [], lines: number[] = []
    text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) { rows.push(l.trim().split(/\s+/)); lines.push(i + 1) } })
    return { rows, lines }
  }
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field.trim() === '') { quoted = true; field = '' }
    else if (c === delim) { row.push(field.trim()); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field.trim()); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field.trim())
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

export function sniffDelimiter(text: string): string {
  const nl = text.indexOf('\n')
  const head = text.slice(0, nl === -1 ? text.length : nl)
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])
  if (counts[0][1] > 1) return counts[0][0]
  return /\S\s{2,}\S/.test(head) || /\S \S/.test(head) ? ' ' : ','
}

/** ISO 8601, epoch seconds or ms, nvidia-smi "2026/10/01 12:00:00.123", Slurm "2026-10-01T12:00:00". No offset means UTC. Returns ms or NaN. */
export function parseTime(raw: string): number {
  const s = raw.trim()
  if (!s) return NaN
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return Number(s)
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i)
  if (!m) return NaN
  const [, y, mo, d, h = '0', mi = '0', se = '0', frac = '0', tz] = m
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number('0.' + frac) * 1000))
  if (tz && !/^(z|utc)$/i.test(tz)) {
    const sign = tz[0] === '-' ? -1 : 1
    const digits = tz.slice(1).replace(':', '')
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
  }
  return t
}

/** Numbers with optional units ("87 %", "1234 MiB", "250.5 W"). [N/A] and blanks are NaN. */
export function parseNum(raw: string | undefined): number {
  if (raw === undefined) return NaN
  const s = raw.trim().replace(/,/g, '')
  if (!s || /n\/?a|null|nan|none|not supported/i.test(s)) return NaN
  const m = s.match(/^-?\d+(\.\d+)?(e-?\d+)?/i)
  return m ? Number(m[0]) : NaN
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : '') : v
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

// ---------- Slurm helpers ----------

/** Expands a Slurm hostlist: "gpu[01-03,07],login1" -> gpu01 gpu02 gpu03 gpu07 login1. */
export function expandHostlist(s: string): string[] {
  const out: string[] = []
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const c of s.trim()) {
    if (c === '[') depth++
    if (c === ']') depth--
    if (c === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += c
  }
  if (cur) parts.push(cur)
  for (const p of parts) {
    const m = p.match(/^(.*?)\[([^\]]+)\](.*)$/)
    if (!m) { if (p && p !== 'None assigned' && p !== '(null)') out.push(p); continue }
    for (const r of m[2].split(',')) {
      const [a, b] = r.split('-')
      if (b === undefined) { out.push(m[1] + a + m[3]); continue }
      for (let i = Number(a); i <= Number(b); i++) out.push(m[1] + String(i).padStart(a.length, '0') + m[3])
    }
  }
  return out
}

/** GPU count and type from AllocTRES ("cpu=32,gres/gpu:h100=8,gres/gpu=8") or a plain number. */
export function parseTres(s: string): { gpus: number; model?: string } {
  if (/^\s*\d+\s*$/.test(s)) return { gpus: Number(s) }
  const generic = s.match(/gres\/gpu=(\d+)/)
  const typed = s.match(/gres\/gpu:([\w.-]+)=(\d+)/)
  return { gpus: generic ? Number(generic[1]) : typed ? Number(typed[2]) : 0, model: typed?.[1] }
}

/** Slurm elapsed "[DD-]HH:MM:SS" or "MM:SS" in seconds. */
export function parseElapsed(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.\d+)?$/)
  if (!m) return NaN
  return (Number(m[1] ?? 0) * 86400) + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

/** "0-3", "0,2,5", "IDX:0-1,4" -> [0,1,2,3] */
export function parseIdx(s: string): number[] {
  const out: number[] = []
  for (const part of s.replace(/^.*IDX:/i, '').replace(/[()]/g, '').split(',')) {
    const [a, b] = part.split('-').map(x => parseInt(x, 10))
    if (Number.isNaN(a)) continue
    for (let i = a; i <= (Number.isNaN(b) || b === undefined ? a : b); i++) out.push(i)
  }
  return out
}

// ---------- GPU catalogue ----------

/** Normalises a model name ("NVIDIA H100 80GB HBM3", "h100", "A100-SXM4-80GB") to a class key. */
export function gpuClass(model: string | undefined): string {
  if (!model) return 'Unknown'
  const m = model.toUpperCase()
  for (const k of ['GB200', 'B200', 'H200', 'H100', 'A100', 'L40S', 'L40', 'L4', 'A30', 'A10', 'T4', 'V100']) if (m.includes(k)) return k
  return model.replace(/^NVIDIA\s+/i, '').split(/\s/)[0] || 'Unknown'
}

const CLASS_MEM_GB: Record<string, number> = { B200: 180, GB200: 186, H200: 141, H100: 80, A100: 80, L40S: 48, L40: 48, L4: 24, A30: 24, A10: 24, T4: 16, V100: 32 }

/** Framebuffer capacity in MiB from an explicit "80GB"/"94GB" in the name, else the class default. */
export function gpuMemMiB(model: string | undefined): number | undefined {
  if (!model) return undefined
  const gb = model.match(/(\d{2,3})\s*GB/i)
  if (gb) return Number(gb[1]) * 1024
  const c = CLASS_MEM_GB[gpuClass(model)]
  return c ? c * 1024 : undefined
}

// ---------- Fleet builder (bucketing) ----------

export type Metric = 'sm' | 'tensor' | 'fb' | 'fbFree' | 'util' | 'power' | 'memTotal' | 'dram'

interface Acc { host: string; gpu: number; uuid?: string; model?: string; memMiB?: number; m: Partial<Record<Metric, Map<number, [number, number]>>>; owner: Map<number, string> }

/** Collects raw samples and averages them into fixed buckets (framebuffer keeps the bucket peak). */
export class FleetBuilder {
  step: number
  accs = new Map<string, Acc>()
  constructor(stepSec = 300) { this.step = stepSec }
  add(host: string, gpu: number, t: number, metric: Metric, v: number, extra?: { uuid?: string; model?: string; owner?: string | null }) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) return
    const key = `${host}:${gpu}`
    let a = this.accs.get(key)
    if (!a) { a = { host, gpu, m: {}, owner: new Map() }; this.accs.set(key, a) }
    if (extra?.uuid) a.uuid = extra.uuid
    if (extra?.model) a.model = extra.model
    const b = Math.floor(t / 1000 / this.step)
    if (metric === 'memTotal') { a.memMiB = v; return }
    if (extra?.owner) a.owner.set(b, extra.owner)
    const map = a.m[metric] ??= new Map()
    const cur = map.get(b)
    if (metric === 'fb') map.set(b, [Math.max(cur?.[0] ?? -Infinity, v), 1])
    else if (cur) { cur[0] += v; cur[1]++ } else map.set(b, [v, 1])
  }
  get size() { return this.accs.size }
  build(): Fleet {
    let lo = Infinity, hi = -Infinity
    for (const a of this.accs.values()) for (const map of Object.values(a.m)) for (const b of map.keys()) { if (b < lo) lo = b; if (b > hi) hi = b }
    if (!Number.isFinite(lo)) return { t0: 0, step: this.step, n: 0, tracks: [] }
    const n = hi - lo + 1
    const tracks: GpuTrack[] = []
    const series = (map: Map<number, [number, number]> | undefined, f = (s: number, c: number) => s / c) => {
      const out = new Array<number>(n).fill(NaN)
      if (map) for (const [b, [s, c]] of map) out[b - lo] = f(s, c)
      return out
    }
    for (const a of [...this.accs.values()].sort((x, y) => x.host.localeCompare(y.host, undefined, { numeric: true }) || x.gpu - y.gpu)) {
      const ratio = (s: number, c: number) => { const v = s / c; return v > 1.0001 ? v / 100 : v }
      const hasSm = !!a.m.sm?.size
      const sm = hasSm ? series(a.m.sm, ratio) : series(a.m.util, ratio)
      const fb = series(a.m.fb)
      const fbFree = series(a.m.fbFree)
      let memMiB = a.memMiB
      if (!memMiB) for (let i = 0; i < n; i++) if (Number.isFinite(fb[i]) && Number.isFinite(fbFree[i])) { memMiB = Math.max(memMiB ?? 0, fb[i] + fbFree[i]) }
      memMiB ??= gpuMemMiB(a.model)
      const owner = new Array<string | null>(n).fill(null)
      for (const [b, o] of a.owner) owner[b - lo] = o
      tracks.push({
        key: `${a.host}:${a.gpu}`, host: a.host, gpu: a.gpu, uuid: a.uuid, model: a.model, memMiB,
        sm, tensor: series(a.m.tensor, ratio), fb, power: series(a.m.power), owner,
        ...(hasSm ? {} : { smProxy: true }),
      })
    }
    return { t0: lo * this.step * 1000, step: this.step, n, tracks }
  }
  /** Re-adds an already bucketed fleet so a new import can be merged into it. */
  addFleet(f: Fleet) {
    for (const tr of f.tracks) {
      const extra = { uuid: tr.uuid, model: tr.model }
      if (tr.memMiB) this.add(tr.host, tr.gpu, f.t0, 'memTotal', tr.memMiB, extra)
      for (let i = 0; i < f.n; i++) {
        const t = f.t0 + i * f.step * 1000
        const o = { ...extra, owner: tr.owner[i] }
        this.add(tr.host, tr.gpu, t, tr.smProxy ? 'util' : 'sm', tr.sm[i], o)
        this.add(tr.host, tr.gpu, t, 'tensor', tr.tensor[i], o)
        this.add(tr.host, tr.gpu, t, 'fb', tr.fb[i], o)
        this.add(tr.host, tr.gpu, t, 'power', tr.power[i], o)
      }
    }
  }
}

export function mergeFleets(a: Fleet | null, b: Fleet): Fleet {
  if (!a || !a.n) return b
  const fb = new FleetBuilder(a.step)
  fb.addFleet(a)
  fb.addFleet(b)
  return fb.build()
}

export function mergeJobs(a: Job[], b: Job[]): Job[] {
  const m = new Map(a.map(j => [j.id, j]))
  for (const j of b) m.set(j.id, j)
  return [...m.values()].sort((x, y) => x.start - y.start)
}

// ---------- DCGM metric names ----------

export function metricFromName(name: string): Metric | null {
  const n = name.toUpperCase().replace(/^.*?(DCGM_FI_)/, '$1')
  if (/PROF_SM_ACTIVE/.test(n)) return 'sm'
  if (/PROF_PIPE_TENSOR_ACTIVE|TENSOR/.test(n)) return 'tensor'
  if (/PROF_DRAM_ACTIVE/.test(n)) return 'dram'
  if (/FB_USED|MEMORY\.USED|MEM_USED/.test(n)) return 'fb'
  if (/FB_FREE|MEMORY\.FREE/.test(n)) return 'fbFree'
  if (/FB_TOTAL|MEMORY\.TOTAL/.test(n)) return 'memTotal'
  if (/DEV_GPU_UTIL|UTILIZATION\.GPU|GPU_UTIL/.test(n)) return 'util'
  if (/POWER/.test(n)) return 'power'
  if (/SM_ACTIVE/.test(n)) return 'sm'
  return null
}

/** Workload identity from dcgm-exporter labels. Prometheus renames clashing labels to exported_*. */
export function ownerFromLabels(l: Record<string, string>): string | null {
  if (l.hpc_job) return l.hpc_job
  const pod = l.exported_pod || (l.pod && !/dcgm-exporter/.test(l.pod) ? l.pod : '')
  const ns = l.exported_namespace || (l.exported_pod ? '' : l.namespace) || ''
  return pod ? (ns ? `${ns}/${pod}` : pod) : null
}

const hostFromLabels = (l: Record<string, string>) => l.Hostname || l.hostname || l.kubernetes_node || l.node || l.instance?.replace(/:\d+$/, '') || ''

// ---------- Formats ----------

export type Format = 'prom-json' | 'prom-csv' | 'nvidia-smi' | 'sacct' | 'k8s-json' | 'k8s-columns' | 'jobs-csv'
export type Schema = 'metrics' | 'jobs'

export const FORMATS: Record<Format, { label: string; schema: Schema }> = {
  'prom-json': { label: 'Prometheus range query (JSON)', schema: 'metrics' },
  'prom-csv': { label: 'DCGM metrics CSV (long or wide)', schema: 'metrics' },
  'nvidia-smi': { label: 'nvidia-smi --query-gpu CSV log', schema: 'metrics' },
  sacct: { label: 'Slurm sacct (parsable)', schema: 'jobs' },
  'k8s-json': { label: 'kubectl get pods -o json', schema: 'jobs' },
  'k8s-columns': { label: 'kubectl custom-columns pod map', schema: 'jobs' },
  'jobs-csv': { label: 'Generic jobs CSV', schema: 'jobs' },
}

export interface FieldSpec { key: string; label: string; required?: boolean; aliases: string[] }

export const METRIC_FIELDS: FieldSpec[] = [
  { key: 'time', label: 'Timestamp', required: true, aliases: ['timestamp', 'time', 'ts', 'date'] },
  { key: 'host', label: 'Host', aliases: ['hostname', 'host', 'node', 'kubernetes_node', 'instance', 'nodename'] },
  { key: 'gpu', label: 'GPU index', required: true, aliases: ['gpu', 'index', 'gpu_index', 'device', 'minor_number'] },
  { key: 'uuid', label: 'GPU UUID', aliases: ['uuid', 'gpu_uuid'] },
  { key: 'model', label: 'GPU model', aliases: ['modelname', 'model', 'name', 'gpu_name', 'product_name'] },
  { key: 'owner', label: 'Job / pod', aliases: ['hpc_job', 'job', 'jobid', 'job_id', 'exported_pod', 'pod'] },
  { key: 'namespace', label: 'Namespace', aliases: ['exported_namespace', 'namespace'] },
  { key: 'metric', label: 'Metric name (long format)', aliases: ['__name__', 'metric', 'metric_name', 'series'] },
  { key: 'value', label: 'Value (long format)', aliases: ['value', 'val', 'y'] },
  { key: 'sm', label: 'SM active', aliases: ['dcgm_fi_prof_sm_active', 'sm_active'] },
  { key: 'tensor', label: 'Tensor active', aliases: ['dcgm_fi_prof_pipe_tensor_active', 'tensor_active'] },
  { key: 'util', label: 'GPU utilisation', aliases: ['dcgm_fi_dev_gpu_util', 'utilization_gpu', 'gpu_util', 'util'] },
  { key: 'fb', label: 'Memory used (MiB)', aliases: ['dcgm_fi_dev_fb_used', 'memory_used', 'fb_used', 'mem_used'] },
  { key: 'fbFree', label: 'Memory free (MiB)', aliases: ['dcgm_fi_dev_fb_free', 'memory_free', 'fb_free'] },
  { key: 'memTotal', label: 'Memory total (MiB)', aliases: ['memory_total', 'fb_total', 'dcgm_fi_dev_fb_total'] },
  { key: 'power', label: 'Power (W)', aliases: ['dcgm_fi_dev_power_usage', 'power_draw', 'power', 'power_usage'] },
]

export const JOB_FIELDS: FieldSpec[] = [
  { key: 'id', label: 'Job / pod ID', required: true, aliases: ['jobid', 'job_id', 'id', 'pod', 'name_pod', 'job'] },
  { key: 'name', label: 'Job name', aliases: ['jobname', 'job_name', 'name'] },
  { key: 'user', label: 'User', aliases: ['user', 'username', 'owner'] },
  { key: 'account', label: 'Account / team', aliases: ['account', 'team', 'project', 'group', 'namespace'] },
  { key: 'partition', label: 'Partition', aliases: ['partition', 'queue'] },
  { key: 'state', label: 'State', aliases: ['state', 'status', 'phase'] },
  { key: 'start', label: 'Start', required: true, aliases: ['start', 'start_time', 'starttime', 'started', 'starttime_utc'] },
  { key: 'end', label: 'End', aliases: ['end', 'end_time', 'endtime', 'finished', 'finishedat'] },
  { key: 'elapsed', label: 'Elapsed', aliases: ['elapsed', 'duration', 'elapsedraw'] },
  { key: 'gpus', label: 'GPUs (count or AllocTRES)', required: true, aliases: ['alloctres', 'gpus', 'gpu_count', 'ngpus', 'tres'] },
  { key: 'nodes', label: 'Node list', required: true, aliases: ['nodelist', 'node', 'nodes', 'host', 'hostname', 'nodename'] },
  { key: 'gpuIdx', label: 'GPU indices', aliases: ['gpu_idx', 'gres_idx', 'gpuidx', 'idx', 'gpu_ids'] },
]

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/[\s\-.]+/g, '_')

export type Mapping = Record<string, number>

export function autoMap(headers: string[], schema: Schema): Mapping {
  const fields = schema === 'metrics' ? METRIC_FIELDS : JOB_FIELDS
  const h = headers.map(norm)
  const used = new Set<number>()
  const map: Mapping = {}
  for (const f of fields) {
    for (const a of f.aliases) {
      const i = h.findIndex((x, k) => !used.has(k) && x === a)
      if (i >= 0) { map[f.key] = i; used.add(i); break }
    }
  }
  // Wide exports that name columns by DCGM field (DCGM_FI_PROF_SM_ACTIVE{...}).
  if (schema === 'metrics') headers.forEach((raw, i) => {
    if (used.has(i)) return
    const m = metricFromName(raw)
    if (m && map[m] === undefined) { map[m] = i; used.add(i) }
  })
  return map
}

export function detectFormat(text: string, fileName = ''): Format {
  const head = text.slice(0, 4000)
  if (/^\s*[[{]/.test(head)) {
    if (/"resultType"|"result"\s*:/.test(head) || /"metric"\s*:\s*{/.test(head)) return 'prom-json'
    return 'k8s-json'
  }
  const first = head.split(/\r?\n/)[0].toLowerCase()
  if (/jobid/.test(first) && first.includes('|')) return 'sacct'
  if (/utilization\.gpu|memory\.used|^timestamp,\s*index/.test(first) || /nvidia-smi|smi/i.test(fileName)) return 'nvidia-smi'
  if (/dcgm_fi|__name__|sm_active/.test(first)) return 'prom-csv'
  if (/namespace/.test(first) && /pod/.test(first) && /node/.test(first)) return 'k8s-columns'
  if (/alloctres|jobid|job_id/.test(first)) return /\|/.test(first) ? 'sacct' : 'jobs-csv'
  if (/value/.test(first) && /gpu/.test(first)) return 'prom-csv'
  return /start/.test(first) ? 'jobs-csv' : 'prom-csv'
}

export interface Parsed {
  format: Format
  schema: Schema
  total: number
  ok: number
  skipped: number
  issues: Issue[]
  fleet?: Fleet
  jobs?: Job[]
}

const MAX_ISSUES = 500
function pushIssue(issues: Issue[], i: Issue) { if (issues.length < MAX_ISSUES) issues.push(i) }

/** Applies a column mapping to parsed CSV rows. hostDefault fills the host for single-node logs (nvidia-smi). */
export function validateCsv(csv: { rows: string[][]; lines: number[] }, map: Mapping, format: Format, opts: { hostDefault?: string; step?: number; now?: number } = {}): Parsed {
  const schema = FORMATS[format].schema
  const issues: Issue[] = []
  const rows = csv.rows.slice(1)
  const lines = csv.lines.slice(1)
  const get = (r: string[], k: string) => map[k] === undefined ? '' : (r[map[k]] ?? '').trim()
  let ok = 0, skipped = 0
  const fields = schema === 'metrics' ? METRIC_FIELDS : JOB_FIELDS
  for (const f of fields) if (f.required && map[f.key] === undefined && !(f.key === 'host' && opts.hostDefault)) {
    pushIssue(issues, { line: csv.lines[0] ?? 1, level: 'error', message: `Map a column to "${f.label}" to import this file.` })
  }
  if (schema === 'metrics') {
    const wide = (['sm', 'tensor', 'util', 'fb', 'fbFree', 'power', 'memTotal'] as Metric[]).filter(m => map[m] !== undefined)
    const long = map.metric !== undefined && map.value !== undefined
    if (!wide.length && !long) pushIssue(issues, { line: csv.lines[0] ?? 1, level: 'error', message: 'Map either Metric name + Value (long format) or at least one metric column such as SM active.' })
    if (map.host === undefined && !opts.hostDefault) pushIssue(issues, { line: csv.lines[0] ?? 1, level: 'error', message: 'No host column. Map one, or type the host name this log came from.' })
    if (issues.some(i => i.level === 'error')) return { format, schema, total: rows.length, ok: 0, skipped: rows.length, issues }
    const fb = new FleetBuilder(opts.step)
    const unknownMetrics = new Set<string>()
    rows.forEach((r, i) => {
      const line = lines[i]
      if (r.length === 1 && r[0] === '') return
      const t = parseTime(get(r, 'time'))
      if (Number.isNaN(t)) { skipped++; pushIssue(issues, { line, level: 'error', message: `Unreadable timestamp "${get(r, 'time')}"` }); return }
      const host = get(r, 'host') || opts.hostDefault || ''
      const gpu = parseInt(get(r, 'gpu'), 10)
      if (!host || Number.isNaN(gpu)) { skipped++; pushIssue(issues, { line, level: 'error', message: !host ? 'Missing host' : `GPU index "${get(r, 'gpu')}" is not a number` }); return }
      const ownerRaw = get(r, 'owner')
      const ns = get(r, 'namespace')
      const extra = { uuid: get(r, 'uuid') || undefined, model: get(r, 'model') || undefined, owner: ownerRaw ? (ns ? `${ns}/${ownerRaw}` : ownerRaw) : null }
      let any = false
      if (long) {
        const name = get(r, 'metric')
        const m = metricFromName(name)
        if (!m) { if (!unknownMetrics.has(name)) { unknownMetrics.add(name); pushIssue(issues, { line, level: 'warn', message: `Ignoring unknown metric "${name}"` }) } return }
        const v = parseNum(get(r, 'value'))
        if (!Number.isNaN(v)) { fb.add(host, gpu, t, m, v, extra); any = true }
      }
      for (const m of wide) {
        const v = parseNum(get(r, m))
        if (!Number.isNaN(v)) { fb.add(host, gpu, t, m, v, extra); any = true }
      }
      if (any) ok++
      else { skipped++; pushIssue(issues, { line, level: 'warn', message: 'No numeric metric values on this row' }) }
    })
    const fleet = fb.build()
    if (fleet.tracks.some(t => t.smProxy)) pushIssue(issues, { line: 0, level: 'warn', message: 'No DCGM_FI_PROF_SM_ACTIVE found for some GPUs, so GPU utilisation is used instead. Utilisation counts any kernel running and overstates real work; treat those numbers as an upper bound.' })
    return { format, schema, total: rows.length, ok, skipped, issues, fleet }
  }
  // Jobs
  if (issues.some(i => i.level === 'error')) return { format, schema, total: rows.length, ok: 0, skipped: rows.length, issues }
  const jobs: Job[] = []
  const now = opts.now ?? Date.now()
  rows.forEach((r, i) => {
    const line = lines[i]
    const id = get(r, 'id')
    if (!id) { skipped++; pushIssue(issues, { line, level: 'error', message: 'Missing job ID' }); return }
    if (/\.(batch|extern|\d+)$/.test(id) && format === 'sacct') { skipped++; return } // job steps; -X avoids them
    const tres = parseTres(get(r, 'gpus') || '0')
    if (!tres.gpus) { skipped++; pushIssue(issues, { line, level: 'warn', message: `Job ${id} has no GPUs allocated, skipped` }); return }
    const start = parseTime(get(r, 'start'))
    if (Number.isNaN(start)) { skipped++; pushIssue(issues, { line, level: 'error', message: `Job ${id}: unreadable start "${get(r, 'start')}"` }); return }
    let end = parseTime(get(r, 'end'))
    if (Number.isNaN(end)) {
      const el = parseElapsed(get(r, 'elapsed'))
      end = Number.isNaN(el) ? now : start + el * 1000
      if (Number.isNaN(el) && !/running|unknown|^$/i.test(get(r, 'end'))) pushIssue(issues, { line, level: 'warn', message: `Job ${id}: no end time, treated as still running` })
    }
    if (end < start) { skipped++; pushIssue(issues, { line, level: 'error', message: `Job ${id} ends before it starts` }); return }
    const hosts = expandHostlist(get(r, 'nodes'))
    if (!hosts.length) { skipped++; pushIssue(issues, { line, level: 'error', message: `Job ${id} has no node list` }); return }
    const idxRaw = get(r, 'gpuIdx')
    const idx = idxRaw ? parseIdx(idxRaw) : []
    const account = get(r, 'account') || 'unassigned'
    jobs.push({
      id, name: get(r, 'name') || undefined, user: get(r, 'user') || account, account,
      partition: get(r, 'partition') || undefined, state: get(r, 'state') || undefined,
      start, end, gpus: tres.gpus, hosts, model: tres.model,
      ...(idx.length ? { gpuIdx: Object.fromEntries(hosts.map(h => [h, idx])) } : {}),
      source: format === 'sacct' ? 'slurm' : format === 'k8s-columns' ? 'k8s' : 'csv',
    })
    ok++
  })
  return { format, schema, total: rows.length, ok, skipped, issues, jobs }
}

interface PromSeries { metric: Record<string, string>; values?: [number, string][]; value?: [number, string] }

/** Prometheus /api/v1/query_range responses: one object, an array of them, or a bare result array. */
export function parsePromJson(text: string, step?: number): Parsed {
  const j = JSON.parse(text)
  const bodies = Array.isArray(j) ? j : [j]
  const series: PromSeries[] = []
  for (const b of bodies) {
    if (b?.data?.result) series.push(...b.data.result)
    else if (b?.metric) series.push(b)
  }
  const issues: Issue[] = []
  const fb = new FleetBuilder(step)
  let ok = 0, skipped = 0, total = 0
  series.forEach((s, i) => {
    const l = s.metric ?? {}
    const m = metricFromName(l.__name__ ?? '')
    const vals = s.values ?? (s.value ? [s.value] : [])
    total += vals.length
    const host = hostFromLabels(l)
    const gpu = parseInt(l.gpu ?? l.GPU ?? l.device?.replace(/\D/g, '') ?? '', 10)
    if (!m || !host || Number.isNaN(gpu)) {
      skipped += vals.length
      pushIssue(issues, { line: i + 1, level: 'error', message: !m ? `Series ${i + 1}: unknown metric "${l.__name__ ?? '(no __name__ label)'}". Query the raw DCGM_FI_* name so the label survives.` : !host ? `Series ${i + 1}: no Hostname/instance label` : `Series ${i + 1}: no gpu label` })
      return
    }
    const extra = { uuid: l.UUID ?? l.uuid, model: l.modelName, owner: ownerFromLabels(l) }
    for (const [t, v] of vals) { const x = parseNum(String(v)); if (Number.isNaN(x)) { skipped++; continue } fb.add(host, gpu, Number(t) * 1000, m, x, extra); ok++ }
  })
  if (!series.length) pushIssue(issues, { line: 1, level: 'error', message: 'No series found. Expected the JSON body of /api/v1/query_range (status, data.result[]).' })
  const fleet = fb.build()
  if (fleet.tracks.some(t => t.smProxy)) pushIssue(issues, { line: 0, level: 'warn', message: 'Some GPUs have no DCGM_FI_PROF_SM_ACTIVE series, so GPU utilisation stands in. It overstates real work; treat it as an upper bound.' })
  return { format: 'prom-json', schema: 'metrics', total, ok, skipped, issues, fleet }
}

/** kubectl get pods -A -o json. Pods requesting nvidia.com/gpu become jobs; team from a "team" label, else namespace. */
export function parseK8sJson(text: string, now = Date.now()): Parsed {
  const j = JSON.parse(text)
  const items: Record<string, any>[] = Array.isArray(j) ? j : j.items ?? []
  const issues: Issue[] = []
  const jobs: Job[] = []
  let skipped = 0
  items.forEach((p, i) => {
    const md = p.metadata ?? {}, spec = p.spec ?? {}, st = p.status ?? {}
    const gpus = [...(spec.containers ?? []), ...(spec.initContainers ?? [])].reduce((s: number, c: any) => s + Number(c?.resources?.limits?.['nvidia.com/gpu'] ?? 0), 0)
    if (!gpus) { skipped++; return }
    const id = `${md.namespace ?? 'default'}/${md.name}`
    if (!spec.nodeName) { skipped++; pushIssue(issues, { line: i + 1, level: 'warn', message: `${id} is not scheduled on a node, skipped` }); return }
    const start = parseTime(st.startTime ?? md.creationTimestamp ?? '')
    if (Number.isNaN(start)) { skipped++; pushIssue(issues, { line: i + 1, level: 'error', message: `${id} has no start time` }); return }
    const fin = (st.containerStatuses ?? []).map((c: any) => parseTime(c?.state?.terminated?.finishedAt ?? '')).filter((x: number) => !Number.isNaN(x))
    const labels = md.labels ?? {}
    jobs.push({
      id, name: md.name, user: labels.user ?? labels['app.kubernetes.io/created-by'] ?? labels.owner ?? md.namespace, account: labels.team ?? md.namespace ?? 'default',
      state: st.phase, start, end: fin.length ? Math.max(...fin) : now, gpus, hosts: [spec.nodeName], source: 'k8s',
      model: spec.nodeSelector?.['nvidia.com/gpu.product'],
    })
  })
  if (!items.length) pushIssue(issues, { line: 1, level: 'error', message: 'No pods found. Expected the output of kubectl get pods -A -o json.' })
  return { format: 'k8s-json', schema: 'jobs', total: items.length, ok: jobs.length, skipped, issues, jobs }
}

/** Full parse with automatic mapping. Used by the worker and the tests. */
export function parseFile(text: string, opts: { fileName?: string; format?: Format; map?: Mapping; hostDefault?: string; step?: number; now?: number } = {}): Parsed & { headers: string[]; map: Mapping } {
  const format = opts.format ?? detectFormat(text, opts.fileName)
  if (format === 'prom-json') return { ...parsePromJson(text, opts.step), headers: [], map: {} }
  if (format === 'k8s-json') return { ...parseK8sJson(text, opts.now), headers: [], map: {} }
  const csv = parseCsv(text)
  const headers = csv.rows[0] ?? []
  const map = opts.map ?? autoMap(headers, FORMATS[format].schema)
  const hostDefault = opts.hostDefault ?? (format === 'nvidia-smi' && map.host === undefined ? hostFromFileName(opts.fileName ?? '') : undefined)
  return { ...validateCsv(csv, map, format, { hostDefault, step: opts.step, now: opts.now }), headers, map }
}

export const hostFromFileName = (n: string) => n.replace(/\.[^.]+$/, '').replace(/^(nvidia-?smi|smi|gpu)[-_]?/i, '').replace(/[-_]?(nvidia-?smi|smi|log)$/i, '') || 'node-1'

/** When only metrics were imported: jobs from dcgm-exporter pod/hpc_job labels (contiguous runs per owner). */
export function jobsFromLabels(f: Fleet): Job[] {
  const by = new Map<string, { hosts: Map<string, Set<number>>; b0: number; b1: number }>()
  for (const t of f.tracks) t.owner.forEach((o, b) => {
    if (!o) return
    let e = by.get(o)
    if (!e) { e = { hosts: new Map(), b0: b, b1: b }; by.set(o, e) }
    e.b0 = Math.min(e.b0, b); e.b1 = Math.max(e.b1, b)
    if (!e.hosts.has(t.host)) e.hosts.set(t.host, new Set())
    e.hosts.get(t.host)!.add(t.gpu)
  })
  return [...by].map(([id, e]) => {
    const ns = id.includes('/') ? id.split('/')[0] : 'unassigned'
    const hosts = [...e.hosts.keys()]
    return {
      id, name: id.split('/').pop(), user: ns, account: ns,
      start: f.t0 + e.b0 * f.step * 1000, end: f.t0 + (e.b1 + 1) * f.step * 1000,
      gpus: [...e.hosts.values()].reduce((s, x) => s + x.size, 0), hosts,
      gpuIdx: Object.fromEntries([...e.hosts].map(([h, s]) => [h, [...s].sort((a, b) => a - b)])), source: 'labels' as const,
    }
  }).sort((a, b) => a.start - b.start)
}
