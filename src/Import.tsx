import { useRef, useState } from 'react'
import { FORMATS, hostFromFileName, JOB_FIELDS, mergeJobs, METRIC_FIELDS, toCsv, type Format } from './engine/parse.ts'
import type { Config } from './engine/types.ts'
import { createBlankProject } from './projectData.ts'
import { getDefaults, putData, saveProject, uuid, type Dataset, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, toast } from './ui.tsx'
import { mergeInWorker, parseInWorker, type ParseResult } from './workerClient.ts'

interface Pending { id: string; name: string; text: string; r: ParseResult; hostDefault: string; localTime: boolean; busy?: boolean }
type Patch = Partial<{ format: Format; map: Record<string, number>; hostDefault: string; localTime: boolean }>

const STEPS = [[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour']] as const

export default function DataTab({ project, ds, update }: { project: Project; ds: Dataset; update(p: Partial<Project>): void; setConfig(p: Partial<Config>): void }) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState(ds.fleet?.step ?? getDefaults().step)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()

  const readFiles = async (files: FileList | File[]) => {
    for (const f of [...files]) {
      if (f.size > 400_000_000) { toast(`${f.name} is over 400 MB. Narrow the time range or raise the query step.`, { tone: 'error' }); continue }
      setBusy(`Parsing ${f.name} (${(f.size / 1e6).toFixed(1)} MB)`)
      try {
        const text = await f.text()
        const r = await parseInWorker({ text, fileName: f.name, step })
        setPending(p => [...p, { id: uuid(), name: f.name, text, r, hostDefault: '', localTime: false }])
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    setBusy(null)
  }

  const reparse = async (p: Pending, patch: Patch) => {
    const localTime = patch.localTime ?? p.localTime
    setPending(x => x.map(y => y.id === p.id ? { ...y, busy: true, hostDefault: patch.hostDefault ?? y.hostDefault, localTime } : y))
    try {
      const format = patch.format ?? p.r.format
      const r = await parseInWorker({ text: p.text, fileName: p.name, format, map: patch.format ? undefined : patch.map ?? p.r.map, hostDefault: patch.hostDefault ?? p.hostDefault, step, localTime })
      setPending(x => x.map(y => y.id === p.id ? { ...y, r, busy: false } : y))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Parse failed', { tone: 'error' })
      setPending(x => x.map(y => y.id === p.id ? { ...y, busy: false } : y))
    }
  }

  const commit = async (p: Pending) => {
    setBusy(`Merging ${p.name}`)
    try {
      const t = project.sampleId ? await createBlankProject('My cluster') : project
      const base: Dataset = project.sampleId ? { fleet: null, jobs: [] } : ds
      const next: Dataset = {
        fleet: p.r.fleet ? await mergeInWorker(base.fleet, p.r.fleet) : base.fleet,
        jobs: p.r.jobs ? mergeJobs(base.jobs, p.r.jobs) : base.jobs,
      }
      await putData(t.id, next)
      const meta = { id: uuid(), kind: p.r.format, fileName: p.name, rows: p.r.ok, skipped: p.r.skipped, at: Date.now() }
      await saveProject({ ...t, imports: [...(project.sampleId ? [] : project.imports), meta], dataMissing: false })
      setPending(x => x.filter(y => y.id !== p.id))
      toast(`Imported ${p.r.ok.toLocaleString()} ${p.r.schema === 'jobs' ? 'jobs' : 'samples'}${p.r.skipped ? `, skipped ${p.r.skipped.toLocaleString()}` : ''}`, { tone: 'ok' })
      if (project.sampleId) go(`/app/p/${t.id}/data`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed', { tone: 'error' })
    } finally { setBusy(null) }
  }

  const f = ds.fleet
  const hosts = f ? new Set(f.tracks.map(t => t.host)).size : 0
  const rawEst = f ? f.tracks.length * f.n * 4 * 6 : 0
  const hasMetrics = !!f?.n
  const hasJobs = ds.jobs.length > 0

  return (
    <>
      {project.dataMissing && <div className="banner warn"><span><strong>This cluster&rsquo;s raw telemetry is on another device.</strong> Settings, rates and snapshots synced; telemetry over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stays where it was imported. Re-import here to recompute.</span></div>}
      {!hasMetrics && !pending.length && (
        <div className="banner"><span><strong>Start here.</strong> Two files make a full report: GPU metrics (DCGM via Prometheus, or nvidia-smi logs) and a job list (Slurm sacct or kubectl pods). Metrics alone work too if dcgm-exporter attaches pod or hpc_job labels. <Link href="/docs">Exact commands</Link>.</span></div>
      )}
      <div className="checklist">
        <div className={hasMetrics ? 'done' : ''}><span aria-hidden="true">{hasMetrics ? '✓' : '1'}</span>GPU metrics {hasMetrics && <small>{f!.tracks.length} GPUs on {hosts} hosts</small>}</div>
        <div className={hasJobs ? 'done' : ''}><span aria-hidden="true">{hasJobs ? '✓' : '2'}</span>Jobs or pods {hasJobs ? <small>{ds.jobs.length.toLocaleString()} jobs</small> : hasMetrics ? <small>optional with labels</small> : null}</div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Import</h2>
          <label className="row gap-sm small">Time bucket
            <select value={step} onChange={e => setStep(Number(e.target.value))} disabled={!!f?.n} style={{ width: 'auto' }} title={f?.n ? 'Fixed by the first import' : 'Samples are averaged into buckets of this width'}>
              {STEPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        </div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new cluster. Want to rehearse with the job list? <button type="button" className="linkish" onClick={() => download(`${project.sampleId}-jobs.csv`, jobsToCsv(ds))}>Download the sample jobs CSV</button> and drop it back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose metric or job exports to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ?? 'Drop exports here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>Prometheus range-query JSON or CSV · dcgm-exporter /metrics scrapes · nvidia-smi CSV logs · sacct -P output · kubectl pods JSON or custom-columns · any jobs CSV. Parsed in a background worker; nothing is uploaded.</p>
          {busy && <span className="spinner" aria-hidden="true" />}
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.json,.log,.out,.prom,.psv" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>

      {pending.map(p => <PendingFile key={p.id} p={p} onReparse={patch => void reparse(p, patch)} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={() => void commit(p)} disabled={!!busy} />)}

      {(project.imports.length > 0 || hasMetrics) && (
        <div className="panel">
          <div className="panel-head"><h2>Imported data</h2>{f?.n ? <span className="muted small">{new Date(f.t0).toISOString().slice(0, 10)} to {new Date(f.t0 + f.n * f.step * 1000).toISOString().slice(0, 10)} · {f.step / 60}-minute buckets</span> : null}</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Format</th><th className="num">Rows</th><th className="num">Skipped</th><th>When</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{FORMATS[i.kind]?.label ?? i.kind}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped.toLocaleString()}</td><td className="small">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
          {!project.sampleId && <p className="muted small">{sync.user
            ? rawEst > RAW_SYNC_LIMIT ? `Telemetry is about ${(rawEst / 1e6).toFixed(0)} MB, so it stays on this device. Rates, thresholds, import log and monthly snapshots still sync.` : 'Synced to your account with rates, thresholds and snapshots.'
            : 'Stored in this browser only. Sign in to sync settings and snapshots across devices.'}</p>}
          <div className="row gap wrap">
            {hasJobs && <button type="button" className="btn sm outline" onClick={() => download(`${project.name.replace(/\W+/g, '-').toLowerCase()}-jobs.csv`, jobsToCsv(ds))}>Download normalised jobs CSV</button>}
            {!project.sampleId && <button type="button" className="btn sm danger-ghost" onClick={async () => {
              if (!(await ask('Clear imported data?', 'Removes all telemetry and jobs from this cluster on this device. Settings and snapshots stay. You can undo for a few seconds.', 'Clear data'))) return
              const before = ds, imports = project.imports
              await putData(project.id, { fleet: null, jobs: [] })
              update({ imports: [] })
              toast('Cleared imported data', { undo: async () => { await putData(project.id, before); update({ imports }) } })
            }}>Clear imported data</button>}
          </div>
        </div>
      )}
    </>
  )
}

function jobsToCsv(ds: Dataset) {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 19)
  return toCsv([['job_id', 'name', 'user', 'account', 'partition', 'state', 'start', 'end', 'gpus', 'nodelist', 'gpu_idx'],
    ...ds.jobs.map(j => [j.id, j.name ?? '', j.user, j.account, j.partition ?? '', j.state ?? '', iso(j.start), iso(j.end), j.gpus, j.hosts.join(','), j.gpuIdx ? Object.values(j.gpuIdx)[0].join(',') : ''])])
}

function PendingFile({ p, onReparse, onCancel, onCommit, disabled }: { p: Pending; onReparse(patch: Patch): void; onCancel(): void; onCommit(): void; disabled: boolean }) {
  const r = p.r
  const fields = r.schema === 'metrics' ? METRIC_FIELDS : JOB_FIELDS
  const errors = r.issues.filter(i => i.level === 'error')
  const csvLike = r.format !== 'prom-json' && r.format !== 'prom-text' && r.format !== 'k8s-json'
  const needsHost = r.schema === 'metrics' && csvLike && r.map.host === undefined
  const fleet = r.fleet
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="break">{p.name}</h2>
        <label className="row gap-sm small">Format
          <select value={r.format} style={{ width: 'auto' }} onChange={e => onReparse({ format: e.target.value as Format })}>
            {(Object.keys(FORMATS) as Format[]).map(f => <option key={f} value={f}>{FORMATS[f].label}</option>)}
          </select>
        </label>
      </div>
      {csvLike && (
        <>
          <h3 className="small strong">Column mapping</h3>
          <div className="map-grid">
            {fields.map(f => (
              <label key={f.key} className="field"><span>{f.label}{f.required && !(f.key === 'gpu' && r.format === 'nvidia-smi') ? ' *' : ''}</span>
                <select value={r.map[f.key] ?? ''} onChange={e => { const map = { ...r.map }; if (e.target.value === '') delete map[f.key]; else map[f.key] = Number(e.target.value); onReparse({ map }) }}>
                  <option value="">Not mapped</option>
                  {r.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
            {needsHost && <label className="field"><span>Host for this log *</span><input defaultValue={p.hostDefault} placeholder={r.format === 'nvidia-smi' ? `${hostFromFileName(p.name)} (from file name)` : 'gpu-node-01'} onBlur={e => onReparse({ hostDefault: e.target.value.trim() })} /></label>}
            <label className="field"><span>Times without a zone are in</span>
              <select value={p.localTime ? 'local' : 'utc'} onChange={e => onReparse({ localTime: e.target.value === 'local' })}>
                <option value="utc">UTC (sacct run with TZ=UTC)</option>
                <option value="local">This browser&rsquo;s zone ({Intl.DateTimeFormat().resolvedOptions().timeZone})</option>
              </select>
            </label>
          </div>
        </>
      )}
      <h3 className="small strong" style={{ marginTop: 8 }}>Validation {p.busy && <span className="spinner sm" aria-label="Re-checking" />}</h3>
      <p className="small">
        <strong className="good-text">{r.ok.toLocaleString()} {r.schema === 'jobs' ? 'jobs' : 'samples'} ready</strong> of {r.total.toLocaleString()} {r.format === 'prom-json' || r.format === 'prom-text' ? 'values' : r.format === 'k8s-json' ? 'pods' : 'rows'}
        {r.skipped > 0 && <>, <strong className="error">{r.skipped.toLocaleString()} skipped</strong></>}
        {r.issues.length > errors.length && <>, {r.issues.length - errors.length} warnings</>}.
        {fleet?.n ? <> {fleet.tracks.length} GPUs on {new Set(fleet.tracks.map(t => t.host)).size} hosts, {new Date(fleet.t0).toISOString().slice(0, 16).replace('T', ' ')} to {new Date(fleet.t0 + fleet.n * fleet.step * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.</> : null}
        {r.jobs?.length ? <> {new Set(r.jobs.map(j => j.account)).size} accounts, {new Set(r.jobs.map(j => j.user)).size} users, {r.jobs.reduce((s, j) => s + j.gpus, 0).toLocaleString()} GPUs requested.</> : null}
      </p>
      {r.issues.length > 0 && (
        <div className="issues" role="log" aria-label="Validation issues">
          {r.issues.slice(0, 200).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">{i.line === 0 ? 'file' : r.format === 'prom-json' ? `series ${i.line}` : r.format === 'prom-text' ? (i.message.startsWith('Series') ? `series ${i.line}` : `line ${i.line}`) : r.format === 'k8s-json' ? `pod ${i.line}` : `line ${i.line}`}</span><span>{i.message}</span></div>)}
          {r.issues.length > 200 && <div><span className="ln" /><span className="muted">and {r.issues.length - 200} more</span></div>}
        </div>
      )}
      <div className="row gap" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={!r.ok || disabled || p.busy} onClick={onCommit}>Import {r.ok.toLocaleString()} {r.schema === 'jobs' ? 'jobs' : 'samples'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
