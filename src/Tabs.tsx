import { useMemo, useState } from 'react'
import { CLASS_LABEL, heatmap, migPlan, type Analysis, type JobStats, type Snapshot } from './engine/analyze.ts'
import { migCommands } from './engine/mig.ts'
import { jobSubmitLua, jobsCsv, jupyterHubCuller, kubeflowCuller, migPartedYaml, policyTargets, promAlert, reaperScript, slurmConf, teamsCsv, userNote } from './engine/policy.ts'
import type { JobClass } from './engine/types.ts'
import { Heatmap, HeatLegend } from './Heatmap.tsx'
import { Counter, useTween } from './motion.tsx'
import type { Tab, TabProps } from './Project.tsx'
import { effectiveJobs } from './projectData.ts'
import { deleteSnapshotCloud } from './sync.ts'
import { ask, Code, CopyButton, download, Empty, fmtMoney, fmtN, fmtPct, fmtPeriod, Link, signed, toast } from './ui.tsx'

export default function Tabs(props: TabProps & { tab: Tab }) {
  switch (props.tab) {
    case 'jobs': return <JobsTab {...props} />
    case 'teams': return <TeamsTab {...props} />
    case 'users': return <UsersTab {...props} />
    case 'policies': return <PoliciesTab {...props} />
    case 'history': return <HistoryTab {...props} />
    default: return <Overview {...props} />
  }
}

const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').toLowerCase()
const money = (a: { cfg: { currency: string } }) => (n: number) => fmtMoney(n, a.cfg.currency)
export const CLASS_ORDER: JobClass[] = ['idle', 'under', 'membound', 'healthy', 'saturated', 'nodata']

export function ClassChip({ c }: { c: JobClass }) { return <span className={`chip c-${c}`}>{CLASS_LABEL[c]}</span> }

// ---------- Overview ----------

function Overview({ a, cfg, setConfig, ds, period }: TabProps) {
  const m = money({ cfg })
  const [after, setAfter] = useState(false)
  const t = useTween(after)
  const hb = useMemo(() => heatmap(ds.fleet!, a.sim.before, a.window, 120), [a, ds])
  const ha = useMemo(() => heatmap(ds.fleet!, a.sim.after, a.window, 120), [a, ds])
  const anyApplied = cfg.applied.idleTimeout || cfg.applied.mig || cfg.applied.fewer
  const idleShare = a.allocGpuHours ? a.idleAllocGpuHours / a.allocGpuHours : 0
  const totalGh = CLASS_ORDER.reduce((s, c) => s + a.byClass[c].gpuHours, 0) || 1
  // Round-robin across recommendation kinds so one pattern does not fill the list.
  const top = useMemo(() => {
    const byKind = new Map<string, JobStats[]>()
    for (const j of a.jobs) if (j.rec.kind !== 'none' && j.rec.kind !== 'share') { const l = byKind.get(j.rec.kind) ?? []; if (l.length < 6) l.push(j); byKind.set(j.rec.kind, l) }
    const out: JobStats[] = []
    for (let i = 0; out.length < 6 && i < 6; i++) for (const l of byKind.values()) if (l[i] && out.length < 6) out.push(l[i])
    return out
  }, [a])
  return (
    <>
      {(a.smProxy || a.inferredJobs > 0) && (
        <div className="banner warn"><span>
          {a.smProxy && <><strong>Some GPUs only report utilisation, not SM activity.</strong> GPU utilisation counts any kernel running, so those numbers are an upper bound. <Link href="/docs#sm-vs-util">Why</Link>. </>}
          {a.inferredJobs > 0 && <><strong>{a.inferredJobs} jobs had no GPU index</strong>, so they were placed on the lowest free GPUs of their node. Add the hpc_job label or a gpu_idx column for exact joins.</>}
        </span></div>
      )}
      <div className="kpis">
        <Kpi label="Allocated" value={fmtPct(a.allocShare)} sub={`${fmtN(a.allocGpuHours)} of ${fmtN(a.capacityGpuHours)} GPU-hours`} />
        <Kpi label="SM active while allocated" value={fmtPct(a.meanSmAllocated)} sub="mean, weighted by GPU-hours" tone={a.meanSmAllocated < 0.4 ? 'bad' : 'good'} />
        <Kpi label="Allocated but idle" value={fmtPct(idleShare)} sub={`${fmtN(a.idleAllocGpuHours)} GPU-hours · ${m(a.idleCost)}`} tone={idleShare > 0.2 ? 'bad' : undefined} />
        <Kpi label="Recoverable" value={`${a.sim.freedGpus.toFixed(1)} GPUs`} sub={`avg freed, peak ${a.sim.peakFreed} · ${fmtN(a.sim.freedGpuHours)} GPU-h`} tone="accent" />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Fleet heatmap</h2>
          <span className="muted small">{a.gpus} GPUs × {fmtPeriod(period)} · SM activity per cell</span>
        </div>
        <div className="sim-bar">
          <div className="seg-control" role="radiogroup" aria-label="View">
            <button type="button" role="radio" aria-checked={!after} className={!after ? 'on' : ''} onClick={() => setAfter(false)}>As scheduled</button>
            <button type="button" role="radio" aria-checked={after} className={after ? 'on' : ''} onClick={() => setAfter(true)} disabled={!anyApplied}>With policies</button>
          </div>
          <div className="row gap wrap small">
            {([['idleTimeout', `Idle timeout ${cfg.idleTimeoutHours}h`], ['mig', 'MIG plan'], ['fewer', 'Right-size GPU counts']] as const).map(([k, l]) => (
              <label key={k} className="row gap-sm"><span className="switch"><input type="checkbox" checked={cfg.applied[k]} onChange={e => setConfig({ applied: { ...cfg.applied, [k]: e.target.checked } })} /><span /></span>{l}</label>
            ))}
          </div>
          <div className="freed" aria-live="polite"><strong><Counter value={after ? a.sim.freedGpus : 0} /></strong><span>GPUs freed (avg)</span></div>
        </div>
        <Heatmap before={hb} after={ha} t={t} idleThr={cfg.idleThreshold} label={`Heatmap of ${a.gpus} GPUs over time, coloured by SM activity`} />
        <div className="row between wrap gap" style={{ marginTop: 10 }}>
          <HeatLegend />
          <span className="muted tiny">Work stays on its node; each time slot is re-packed onto the lowest GPU indices.</span>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Where the GPU-hours went</h2><Link href={`${location.pathname.replace(/\/$/, '')}/jobs${location.search}`} className="small">All jobs</Link></div>
          <div className="stackbar" role="img" aria-label="GPU-hours by job class">
            {CLASS_ORDER.filter(c => a.byClass[c].gpuHours > 0).map(c => <span key={c} className={`c-${c}`} style={{ width: `${(a.byClass[c].gpuHours / totalGh) * 100}%` }} title={`${CLASS_LABEL[c]}: ${fmtN(a.byClass[c].gpuHours)} GPU-h`} />)}
          </div>
          <table className="compact">
            <tbody>{CLASS_ORDER.filter(c => a.byClass[c].jobs > 0).map(c => (
              <tr key={c}><th scope="row"><ClassChip c={c} /></th><td className="num">{fmtN(a.byClass[c].jobs)} jobs</td><td className="num">{fmtN(a.byClass[c].gpuHours)} GPU-h</td><td className="num muted">{fmtPct(a.byClass[c].gpuHours / totalGh)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Biggest wins</h2><span className="muted small">by recoverable spend</span></div>
          {top.length === 0 ? <p className="muted">Nothing to fix in this period.</p> : (
            <ol className="wins">{top.map(j => (
              <li key={j.id}>
                <div className="row between gap"><strong className="break mono small">{j.id}{j.name ? ` · ${j.name}` : ''}</strong><span className="small strong">{m(Math.max(j.idleCost, j.recoverableGpuHours * j.rate))}</span></div>
                <div className="muted small">{j.user} · {j.account} · {j.gpus}× {j.model}</div>
                <div className="small">{j.rec.text}</div>
              </li>
            ))}</ol>
          )}
        </div>
      </div>
    </>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'accent' }) {
  return <div className={`kpi${tone ? ' ' + tone : ''}`}><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{sub && <div className="kpi-sub">{sub}</div>}</div>
}

// ---------- Jobs ----------

function JobsTab({ a, cfg, project, period }: TabProps) {
  const m = money({ cfg })
  const [cls, setCls] = useState<JobClass | ''>(() => (new URLSearchParams(location.search).get('class') as JobClass) || '')
  const [acct, setAcct] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<keyof JobStats | 'waste'>('waste')
  const [limit, setLimit] = useState(100)
  const [open, setOpen] = useState<string | null>(null)
  const accounts = useMemo(() => [...new Set(a.jobs.map(j => j.account))].sort(), [a])
  const list = useMemo(() => {
    const ql = q.toLowerCase()
    const l = a.jobs.filter(j => (!cls || j.cls === cls) && (!acct || j.account === acct) && (!ql || `${j.id} ${j.name ?? ''} ${j.user}`.toLowerCase().includes(ql)))
    const key = (j: JobStats) => sort === 'waste' ? Math.max(j.idleCost, j.recoverableGpuHours * j.rate) : (j[sort] as number)
    return sort === 'waste' || typeof a.jobs[0]?.[sort as keyof JobStats] === 'number' ? [...l].sort((x, y) => (key(y) || 0) - (key(x) || 0)) : l
  }, [a, cls, acct, q, sort])
  const th = (k: keyof JobStats | 'waste', l: string) => <th className="num"><button type="button" className={`sort${sort === k ? ' on' : ''}`} onClick={() => setSort(k)}>{l}</button></th>
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Jobs</h2>
        <div className="row gap-sm wrap">
          <button type="button" className="btn sm outline" onClick={() => download(`${slug(project.name)}-${period}-jobs.csv`, jobsCsv(a, cfg.currency))}>Export CSV</button>
        </div>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search job, name or user" value={q} onChange={e => setQ(e.target.value)} aria-label="Search jobs" />
        <select value={cls} onChange={e => setCls(e.target.value as JobClass | '')} aria-label="Class">
          <option value="">All classes</option>
          {CLASS_ORDER.filter(c => a.byClass[c].jobs).map(c => <option key={c} value={c}>{CLASS_LABEL[c]} ({a.byClass[c].jobs})</option>)}
        </select>
        <select value={acct} onChange={e => setAcct(e.target.value)} aria-label="Account"><option value="">All accounts</option>{accounts.map(x => <option key={x}>{x}</option>)}</select>
      </div>
      <p className="muted small">{fmtN(list.length)} jobs. Click a row for per-GPU detail. SM active below {fmtPct(cfg.idleThreshold)} counts as idle.</p>
      {list.length === 0 ? <Empty title="No jobs match"><p className="muted">Clear a filter.</p></Empty> : (
        <div className="table-wrap">
          <table className="jobs">
            <thead><tr><th>Job</th><th>Account / user</th>{th('gpus', 'GPUs')}{th('gpuHours', 'GPU-h')}{th('meanSm', 'SM mean')}{th('p95Sm', 'SM p95')}{th('fbPeakFrac', 'Mem peak')}{th('idleGpuHours', 'Idle GPU-h')}<th>Class</th>{th('waste', 'Waste')}</tr></thead>
            <tbody>
              {list.slice(0, limit).map(j => [
                <tr key={j.id} className={`clickable${open === j.id ? ' open' : ''}`} onClick={() => setOpen(open === j.id ? null : j.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(open === j.id ? null : j.id) }} aria-expanded={open === j.id}>
                  <th scope="row" className="mono small break">{j.id}{j.name && <div className="muted tiny">{j.name}</div>}</th>
                  <td className="small">{j.account}<div className="muted tiny">{j.user}</div></td>
                  <td className="num">{j.gpus}</td>
                  <td className="num">{fmtN(j.gpuHours, j.gpuHours < 10 ? 1 : 0)}</td>
                  <td className="num">{fmtPct(j.meanSm)}</td>
                  <td className="num">{fmtPct(j.p95Sm)}</td>
                  <td className="num">{Number.isFinite(j.fbPeakFrac) ? `${(j.fbPeakMiB / 1024).toFixed(0)}/${(j.memMiB / 1024).toFixed(0)} GiB` : '—'}</td>
                  <td className="num">{fmtN(j.idleGpuHours)}</td>
                  <td><ClassChip c={j.cls} /></td>
                  <td className="num strong">{m(Math.max(j.idleCost, j.recoverableGpuHours * j.rate))}</td>
                </tr>,
                open === j.id && <tr key={j.id + '-d'} className="detail"><td colSpan={10}><JobDetail j={j} /></td></tr>,
              ])}
            </tbody>
          </table>
        </div>
      )}
      {list.length > limit && <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 200)}>Show more ({fmtN(list.length - limit)} left)</button>}
    </div>
  )
}

function JobDetail({ j }: { j: JobStats }) {
  return (
    <div className="job-detail">
      <div>
        <div className="small strong">SM active per GPU</div>
        <div className="gpu-bars">{j.perGpuSm.map((v, i) => <div key={i} title={`GPU ${i + 1}: ${fmtPct(v)}`}><span style={{ height: `${Math.max(2, (v || 0) * 100)}%` }} /></div>)}</div>
        <div className="muted tiny">Imbalance {Number.isFinite(j.imbalance) ? j.imbalance.toFixed(2) : '—'} · time at zero {fmtPct(j.timeAtZero)} · tensor mean {fmtPct(j.meanTensor)}{j.inferred ? ' · GPU indices inferred' : ''}{j.smProxy ? ' · utilisation proxy' : ''}</div>
      </div>
      <div>
        <div className="small strong">Recommendation</div>
        <p className="small" style={{ margin: '4px 0' }}>{j.rec.text}</p>
        <div className="muted tiny">{j.gpus} GPUs → {j.rec.gpusAfter.toFixed(2).replace(/\.00$/, '')} GPU-equivalents · {fmtN(j.recoverableGpuHours)} GPU-h recoverable</div>
      </div>
    </div>
  )
}

// ---------- Chargeback ----------

function TeamsTab({ a, cfg, setConfig, project, period }: TabProps) {
  const m = money({ cfg })
  const classes = useMemo(() => [...new Set(a.jobs.map(j => j.model))].filter(c => c !== 'Unknown').sort(), [a])
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Rates</h2><span className="muted small">$/GPU-hour, editable. Defaults are illustrative, not quotes.</span></div>
        <div className="inline-fields">
          {classes.map(c => <label key={c} className="field"><span>{c} ({cfg.currency}/GPU-h)</span><input type="number" min="0" step="0.05" value={cfg.rates[c] ?? cfg.defaultRate} onChange={e => setConfig({ rates: { ...cfg.rates, [c]: Math.max(0, Number(e.target.value)) } })} /></label>)}
          <label className="field"><span>Other GPUs</span><input type="number" min="0" step="0.05" value={cfg.defaultRate} onChange={e => setConfig({ defaultRate: Math.max(0, Number(e.target.value)) })} /></label>
          <label className="field"><span>Currency</span><select value={cfg.currency} onChange={e => setConfig({ currency: e.target.value })}>{['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD'].map(c => <option key={c}>{c}</option>)}</select></label>
        </div>
        <AmortCalc onUse={(r, c) => setConfig({ rates: { ...cfg.rates, [c]: r } })} classes={classes} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Chargeback by account</h2>
          <button type="button" className="btn sm outline" onClick={() => download(`${slug(project.name)}-${period}-chargeback.csv`, teamsCsv(a, cfg.currency))}>Export CSV</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account</th><th className="num">Jobs</th><th className="num">Users</th><th className="num">GPU-hours</th><th className="num">SM active</th><th className="num">Idle GPU-h</th><th className="num">Charge</th><th className="num">Idle spend</th><th className="num">Recoverable</th><th /></tr></thead>
            <tbody>{a.teams.map(t => (
              <tr key={t.account}>
                <th scope="row">{t.account}</th><td className="num">{fmtN(t.jobs)}</td><td className="num">{t.users}</td><td className="num">{fmtN(t.gpuHours)}</td>
                <td className="num"><span className="meter" style={{ ['--v' as string]: `${(t.meanSm || 0) * 100}%` }}>{fmtPct(t.meanSm)}</span></td>
                <td className="num">{fmtN(t.idleGpuHours)}</td><td className="num strong">{m(t.cost)}</td><td className="num bad-text">{m(t.idleCost)}</td><td className="num">{t.recoverableGpus.toFixed(1)} GPUs</td>
                <td><Link href={`/app/p/${project.id}/report?team=${encodeURIComponent(t.account)}&p=${period}`} className="btn ghost sm">Statement</Link></td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th>Total</th><td className="num">{fmtN(a.jobs.length)}</td><td /><td className="num">{fmtN(a.allocGpuHours)}</td><td className="num">{fmtPct(a.meanSmAllocated)}</td><td className="num">{fmtN(a.idleAllocGpuHours)}</td><td className="num strong">{m(a.cost)}</td><td className="num">{m(a.idleCost)}</td><td className="num">{a.sim.freedGpus.toFixed(1)} GPUs</td><td /></tr></tfoot>
          </table>
        </div>
        <p className="muted small">Charge = allocated GPU-hours × rate, whether or not the GPUs did work. Idle spend is the part with SM active under {fmtPct(cfg.idleThreshold)}. Recoverable is the average number of whole GPUs the policies free for this account.</p>
      </div>
    </>
  )
}

function AmortCalc({ onUse, classes }: { onUse(rate: number, cls: string): void; classes: string[] }) {
  const [capex, setCapex] = useState(35000)
  const [years, setYears] = useState(4)
  const [opex, setOpex] = useState(3500)
  const [cls, setCls] = useState(classes[0] ?? 'H100')
  const rate = (capex + opex * years) / (years * 8760)
  return (
    <details className="calc">
      <summary>On-prem? Work out an amortised rate</summary>
      <div className="inline-fields" style={{ marginTop: 10 }}>
        <label className="field"><span>Capex per GPU incl. server share</span><input type="number" value={capex} onChange={e => setCapex(Number(e.target.value))} /></label>
        <label className="field"><span>Years of service</span><input type="number" min="1" value={years} onChange={e => setYears(Math.max(1, Number(e.target.value)))} /></label>
        <label className="field"><span>Power, cooling, support / GPU / year</span><input type="number" value={opex} onChange={e => setOpex(Number(e.target.value))} /></label>
        <label className="field"><span>Apply to</span><select value={cls} onChange={e => setCls(e.target.value)}>{(classes.length ? classes : ['H100']).map(c => <option key={c}>{c}</option>)}</select></label>
      </div>
      <div className="row gap"><span>(capex + opex × years) ÷ (years × 8,760 h) = <strong>{rate.toFixed(2)}/GPU-h</strong></span><button type="button" className="btn sm primary" onClick={() => { onUse(Math.round(rate * 100) / 100, cls); toast(`${cls} rate set to ${rate.toFixed(2)}`, { tone: 'ok' }) }}>Use this rate</button></div>
    </details>
  )
}

// ---------- Users ----------

function UsersTab({ a, cfg, project, period }: TabProps) {
  const m = money({ cfg })
  const [sel, setSel] = useState(a.users[0] ? `${a.users[0].account}\u0000${a.users[0].user}` : '')
  const u = a.users.find(x => `${x.account}\u0000${x.user}` === sel)
  const note = u ? userNote(u.user, a.jobs.filter(j => j.account === u.account), fmtPeriod(period), m) : ''
  return (
    <div className="grid-users">
      <div className="panel">
        <div className="panel-head"><h2>Users</h2><span className="muted small">by idle spend</span></div>
        <ul className="user-list">{a.users.map(x => {
          const k = `${x.account}\u0000${x.user}`
          return <li key={k}><button type="button" className={k === sel ? 'on' : ''} onClick={() => setSel(k)} aria-pressed={k === sel}>
            <span><strong>{x.user}</strong><small>{x.account} · {x.jobs} jobs</small></span><span className="small">{m(x.idleCost)}</span>
          </button></li>
        })}</ul>
      </div>
      {u && (
        <div className="panel">
          <div className="panel-head">
            <h2>{u.user}</h2>
            <div className="row gap-sm"><CopyButton text={note} label="Copy message" /><Link className="btn sm primary" href={`/app/p/${project.id}/report?user=${encodeURIComponent(u.user)}&team=${encodeURIComponent(u.account)}&p=${period}`}>Printable report</Link></div>
          </div>
          <div className="kpis mini">
            <Kpi label="GPU-hours" value={fmtN(u.gpuHours)} />
            <Kpi label="SM active" value={fmtPct(u.meanSm)} />
            <Kpi label="Idle GPU-hours" value={fmtN(u.idleGpuHours)} tone={u.idleGpuHours / Math.max(1, u.gpuHours) > 0.25 ? 'bad' : undefined} />
            <Kpi label="Charge" value={m(u.cost)} sub={`${m(u.idleCost)} idle`} />
          </div>
          <h3 className="small strong">Top waste and how to fix it</h3>
          <ol className="wins">{u.top.filter(j => j.rec.kind !== 'none').map(j => <li key={j.id}><div className="row between gap"><strong className="mono small">{j.id}{j.name ? ` · ${j.name}` : ''}</strong><ClassChip c={j.cls} /></div><div className="small">{j.rec.text}</div></li>)}</ol>
          {u.top.every(j => j.rec.kind === 'none') && <p className="muted">No waste worth chasing. Nice.</p>}
          <details><summary className="small">Message preview</summary><pre className="note">{note}</pre></details>
        </div>
      )}
    </div>
  )
}

// ---------- Policy pack ----------

function PoliciesTab({ a, cfg, setConfig, ds, project, update }: TabProps) {
  const jobs = useMemo(() => effectiveJobs(ds), [ds])
  const f = ds.fleet!
  const plans = useMemo(() => migPlan(f, a, jobs), [f, a, jobs])
  const targets = policyTargets(a, new Map(jobs.map(j => [j.id, j.partition])))
  const slurm = jobs.some(j => j.source === 'slurm')
  const k8s = jobs.some(j => j.source === 'k8s' || j.source === 'labels')
  const ctx = { cfg, a, interactivePartitions: targets.partitions, notebookNamespaces: targets.namespaces, promUrl: project.promUrl || 'http://prometheus.monitoring:9090' }
  const idle = a.byClass.idle
  const freedMig = plans.reduce((s, p) => s + p.gpusFreed, 0)
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Policy settings</h2><span className="muted small">Everything below regenerates as you type</span></div>
        <div className="inline-fields">
          <label className="field"><span>Idle threshold (SM active)</span><input type="number" min="0.01" max="0.5" step="0.01" value={cfg.idleThreshold} onChange={e => setConfig({ idleThreshold: Math.min(0.5, Math.max(0.005, Number(e.target.value))) })} /></label>
          <label className="field"><span>Idle timeout (hours)</span><input type="number" min="0.5" max="72" step="0.5" value={cfg.idleTimeoutHours} onChange={e => setConfig({ idleTimeoutHours: Math.min(72, Math.max(0.5, Number(e.target.value))) })} /></label>
          <label className="field"><span>Memory headroom for MIG</span><input type="number" min="0" max="1" step="0.05" value={cfg.memHeadroom} onChange={e => setConfig({ memHeadroom: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>
          <label className="field"><span>Prometheus URL</span><input defaultValue={ctx.promUrl} onBlur={e => update({ promUrl: e.target.value.trim() })} /></label>
        </div>
        <p className="small" style={{ margin: 0 }}>This period: <strong>{idle.jobs} idle jobs</strong> held {fmtN(idle.gpuHours)} GPU-hours. With all three policies the fleet frees <strong>{a.sim.freedGpus.toFixed(1)} GPUs on average</strong> (peak {a.sim.peakFreed}).</p>
      </div>

      {(slurm || !k8s) && (
        <div className="panel">
          <div className="panel-head"><h2>Slurm: idle-job timeout</h2><span className="muted small">Partitions with idle sessions: {targets.partitions.join(', ')}</span></div>
          <p className="small">Slurm has no built-in "GPU idle" kill. The usual pattern: cap interactive time with partition limits and job_submit.lua, then let a small reaper cancel jobs whose GPUs show no SM activity for {cfg.idleTimeoutHours}h. Run the reaper with DRY_RUN=1 for a week and share the log first.</p>
          <Code label="slurm.conf" code={slurmConf(ctx)} />
          <Code label="job_submit.lua" code={jobSubmitLua(ctx)} />
          <Code label="idle-gpu-reaper.sh" code={reaperScript(ctx)} />
        </div>
      )}
      {(k8s || !slurm) && (
        <div className="panel">
          <div className="panel-head"><h2>Kubernetes: idle notebook culler</h2><span className="muted small">Namespaces with idle notebooks: {targets.namespaces.join(', ')}</span></div>
          <Code label="JupyterHub values.yaml" code={jupyterHubCuller(ctx)} />
          <Code label="Kubeflow notebook-controller patch" code={kubeflowCuller(ctx)} />
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Alert on allocated-but-idle GPUs</h2></div>
        <Code label="PrometheusRule" code={promAlert(ctx)} />
      </div>

      <div className="panel">
        <div className="panel-head"><h2>MIG partition plan</h2><span className="muted small">{plans.length ? `${plans.length} nodes · ${freedMig} whole GPUs freed at peak demand` : 'No MIG candidates this period'}</span></div>
        {plans.length === 0 ? <p className="muted">No job here is light enough for a MIG slice on a MIG-capable GPU (A100, A30, H100, H200).</p> : (
          <>
            <p className="small">Sized for the busiest moment of the month on each node: every compute-light job that ran at the same time gets the smallest profile that fits its peak memory plus {fmtPct(cfg.memHeadroom)} headroom and its p95 SM activity. Profiles from NVIDIA's MIG user guide (table checked 2026-11-01).</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Node</th><th>GPU</th><th>Layout</th><th className="num">Jobs seen</th><th className="num">GPUs freed</th></tr></thead>
                <tbody>{plans.map(p => <tr key={p.host}><th scope="row" className="mono small">{p.host}</th><td className="small">{p.gpuLabel}</td><td className="small">{p.layout.map((l, i) => <div key={i}><span className="muted">GPU {i}:</span> {l.join(' + ')}</div>)}</td><td className="num">{p.jobs.length}</td><td className="num strong">{p.gpusFreed}</td></tr>)}</tbody>
              </table>
            </div>
            <Code label="nvidia-smi (bare metal / Slurm nodes)" code={plans.map(p => migCommands(p.host, p.layout)).join('\n\n')} />
            <Code label="mig-parted config (GPU Operator)" code={migPartedYaml(plans)} />
            <p className="muted small">Slurm: after partitioning, list the MIG devices in gres.conf (AutoDetect=nvml) and request them as --gres=gpu:1g.10gb:1. Kubernetes: with the mixed strategy pods request nvidia.com/mig-1g.10gb: 1.</p>
          </>
        )}
      </div>
    </>
  )
}

// ---------- History ----------

function HistoryTab({ project, update, a, period }: TabProps) {
  const snaps = [...project.snapshots].sort((x, y) => x.period.localeCompare(y.period))
  const [aId, setA] = useState(snaps.at(-2)?.id ?? '')
  const [bId, setB] = useState(snaps.at(-1)?.id ?? '')
  if (!snaps.length) return <div className="panel"><Empty title="No snapshots yet"><p className="muted">Save a snapshot each month (press S) to track utilisation after policy changes.</p></Empty></div>
  const A = snaps.find(s => s.id === aId) ?? snaps[0]
  const B = snaps.find(s => s.id === bId) ?? snaps.at(-1)!
  const remove = async (s: Snapshot) => {
    if (!(await ask(`Delete the ${s.label} snapshot?`, 'You can undo for a few seconds.', 'Delete'))) return
    const before = project.snapshots
    update({ snapshots: before.filter(x => x.id !== s.id) })
    void deleteSnapshotCloud(s.id)
    toast(`Deleted ${s.label}`, { undo: () => update({ snapshots: before }) })
  }
  const setNote = (s: Snapshot, note: string) => update({ snapshots: project.snapshots.map(x => x.id === s.id ? { ...x, note: note || undefined } : x) })
  const projected = period !== 'all' ? { label: 'With policies (projected)', sm: a.allocGpuHours ? a.meanSmAllocated * a.allocGpuHours / Math.max(1, a.allocGpuHours - a.sim.freedGpuHours) : 0 } : null
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Utilisation trend</h2><span className="muted small">SM active on allocated GPUs, and the idle share</span></div>
        <Trend snaps={snaps} projected={projected} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Compare</h2>
          <div className="row gap-sm wrap">
            <select value={A.id} onChange={e => setA(e.target.value)} aria-label="From snapshot">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            <span aria-hidden="true">→</span>
            <select value={B.id} onChange={e => setB(e.target.value)} aria-label="To snapshot">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Metric</th><th className="num">{A.label}</th><th className="num">{B.label}</th><th className="num">Change</th></tr></thead>
            <tbody>
              {([
                ['GPUs', A.gpus, B.gpus, (n: number) => fmtN(n), null],
                ['Allocated', A.allocShare, B.allocShare, (n: number) => fmtPct(n, 1), null],
                ['SM active while allocated', A.meanSmAllocated, B.meanSmAllocated, (n: number) => fmtPct(n, 1), true],
                ['Allocated but idle', A.idleShare, B.idleShare, (n: number) => fmtPct(n, 1), false],
                ['Idle GPU-hours', A.idleAllocGpuHours, B.idleAllocGpuHours, (n: number) => fmtN(n), false],
                ['Spend', A.cost, B.cost, (n: number) => fmtMoney(n), null],
                ['Idle spend', A.idleCost, B.idleCost, (n: number) => fmtMoney(n), false],
                ['Recoverable GPUs', A.recoverableGpus, B.recoverableGpus, (n: number) => n.toFixed(1), false],
              ] as const).map(([l, x, y, f, upGood]) => {
                const d = y - x
                const good = upGood ? d > 0 : d < 0
                return <tr key={l}><th scope="row">{l}</th><td className="num">{f(x)}</td><td className="num">{f(y)}</td><td className={`num ${Math.abs(d) < 1e-9 || upGood === null ? 'muted' : good ? 'good-text' : 'bad-text'}`}>{signed(d, f)}</td></tr>
              })}
            </tbody>
          </table>
        </div>
        <h3 className="small strong" style={{ marginTop: 16 }}>By account</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account</th><th className="num">SM {A.label}</th><th className="num">SM {B.label}</th><th className="num">Idle GPU-h change</th><th className="num">Spend change</th></tr></thead>
            <tbody>{[...new Set([...A.teams, ...B.teams].map(t => t.account))].map(acc => {
              const x = A.teams.find(t => t.account === acc), y = B.teams.find(t => t.account === acc)
              const di = (y?.idleGpuHours ?? 0) - (x?.idleGpuHours ?? 0), dc = (y?.cost ?? 0) - (x?.cost ?? 0)
              return <tr key={acc}><th scope="row">{acc}</th><td className="num">{fmtPct(x?.meanSm ?? NaN)}</td><td className="num">{fmtPct(y?.meanSm ?? NaN)}</td><td className={`num ${di < 0 ? 'good-text' : di > 0 ? 'bad-text' : ''}`}>{signed(di, n => fmtN(n))}</td><td className="num">{signed(dc, n => fmtMoney(n))}</td></tr>
            })}</tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Snapshots</h2><span className="muted small">Note what changed (for example "idle timeout on from 15 Sep") so the trend has context</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Month</th><th className="num">SM active</th><th className="num">Idle share</th><th className="num">Spend</th><th>Note</th><th /></tr></thead>
            <tbody>{[...snaps].reverse().map(s => <tr key={s.id}><th scope="row">{s.label}</th><td className="num">{fmtPct(s.meanSmAllocated, 1)}</td><td className="num">{fmtPct(s.idleShare, 1)}</td><td className="num">{fmtMoney(s.cost)}</td>
              <td><input className="table-input" defaultValue={s.note ?? ''} placeholder="Policy change, new nodes…" aria-label={`Note for ${s.label}`} onBlur={e => { if ((e.target.value || undefined) !== s.note) setNote(s, e.target.value.trim()) }} /></td>
              <td><button type="button" className="btn danger-ghost sm" onClick={() => void remove(s)}>Delete</button></td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Trend({ snaps, projected }: { snaps: Snapshot[]; projected: { label: string; sm: number } | null }) {
  const pts = snaps.map(s => ({ label: s.label.replace(/ \d{4}$/, ''), sm: s.meanSmAllocated, idle: s.idleShare, note: s.note }))
  const W = 640, H = 220, pad = { l: 40, r: 16, t: 14, b: 30 }
  const n = pts.length + (projected ? 1 : 0)
  const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : i * (W - pad.l - pad.r) / (n - 1))
  const y = (v: number) => pad.t + (1 - Math.min(1, v)) * (H - pad.t - pad.b)
  const line = (k: 'sm' | 'idle') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[k])}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="trend" role="img" aria-label={`Trend over ${pts.length} snapshots`}>
      {[0, 0.25, 0.5, 0.75, 1].map(v => <g key={v}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" /><text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="axis">{v * 100}%</text></g>)}
      <path d={line('idle')} className="ln idle" />
      <path d={line('sm')} className="ln sm" />
      {projected && <><path d={`M${x(pts.length - 1)},${y(pts.at(-1)!.sm)}L${x(pts.length)},${y(projected.sm)}`} className="ln sm dashed" /><circle cx={x(pts.length)} cy={y(projected.sm)} r={5} className="dot proj" /><text x={x(pts.length)} y={H - 10} textAnchor="middle" className="axis">With policies</text></>}
      {pts.map((p, i) => <g key={i}>
        <circle cx={x(i)} cy={y(p.sm)} r={4.5} className="dot sm"><title>{`${p.label}: SM ${(p.sm * 100).toFixed(1)}%${p.note ? ' · ' + p.note : ''}`}</title></circle>
        <circle cx={x(i)} cy={y(p.idle)} r={3.5} className="dot idle"><title>{`${p.label}: idle ${(p.idle * 100).toFixed(1)}%`}</title></circle>
        <text x={x(i)} y={H - 10} textAnchor="middle" className="axis">{p.label}</text>
        {p.note && <text x={x(i)} y={y(p.sm) - 10} textAnchor="middle" className="axis note">●</text>}
      </g>)}
      <g transform={`translate(${pad.l + 8},${pad.t + 4})`} className="axis"><circle r="4" className="dot sm" cx="4" cy="0" /><text x="12" y="4">SM active</text><circle r="4" className="dot idle" cx="92" cy="0" /><text x="100" y="4">Idle share</text></g>
    </svg>
  )
}
