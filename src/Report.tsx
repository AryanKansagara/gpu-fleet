import { useEffect, useMemo } from 'react'
import { CLASS_LABEL, type JobStats } from './engine/analyze.ts'
import { defaultPeriod, periodOptions, useAnalysis, useProject } from './projectData.ts'
import { fmtMoney, fmtN, fmtPct, fmtPeriod, Link, Monogram, SyntheticBadge } from './ui.tsx'

/** Printable monthly statement for one account, or a "your jobs" report for one user. */
export default function Report({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const q = new URLSearchParams(location.search)
  const team = q.get('team'), user = q.get('user')
  const opts = useMemo(() => periodOptions(ds), [ds])
  const period = q.get('p') && opts.includes(q.get('p')!) ? q.get('p')! : defaultPeriod(ds)
  const a = useAnalysis(ds, project?.config, period)
  useEffect(() => { if (project) document.title = `${user ?? team ?? 'Fleet'} · ${fmtPeriod(period)} · GPU Fleet Report` }, [project?.name, team, user, period])

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Building the statement</div>
  if (!project || !a) return <section className="page narrow center"><h1>Nothing to report</h1><p className="muted">This cluster has no data for that period.</p><Link href="/app" className="btn primary">Clusters</Link></section>
  const cur = project.config.currency
  const m = (n: number) => fmtMoney(n, cur)
  const jobs = a.jobs.filter(j => (!team || j.account === team) && (!user || j.user === user))
  const gh = jobs.reduce((s, j) => s + j.gpuHours, 0)
  const cost = jobs.reduce((s, j) => s + j.cost, 0)
  const idleGh = jobs.reduce((s, j) => s + j.idleGpuHours, 0)
  const idleCost = jobs.reduce((s, j) => s + j.idleCost, 0)
  const smw = jobs.filter(j => Number.isFinite(j.meanSm))
  const sm = smw.reduce((s, j) => s + j.meanSm * j.gpuHours, 0) / Math.max(1e-9, smw.reduce((s, j) => s + j.gpuHours, 0))
  const byClass = new Map<string, { gh: number; rate: number; cost: number }>()
  for (const j of jobs) { const r = byClass.get(j.model) ?? { gh: 0, rate: j.rate, cost: 0 }; r.gh += j.gpuHours; r.cost += j.cost; byClass.set(j.model, r) }
  const users = new Map<string, { gh: number; cost: number; idle: number; n: number }>()
  for (const j of jobs) { const u = users.get(j.user) ?? { gh: 0, cost: 0, idle: 0, n: 0 }; u.gh += j.gpuHours; u.cost += j.cost; u.idle += j.idleCost; u.n++; users.set(j.user, u) }
  const fixes = jobs.filter(j => j.rec.kind !== 'none').slice(0, user ? 10 : 8)
  const back = `/app/p/${id}/${user ? 'users' : 'teams'}?p=${period}`
  const title = user ? `GPU usage report: ${user}` : team ? `Monthly GPU statement: ${team}` : 'Fleet GPU statement'

  return (
    <div className="report">
      <div className="report-actions no-print">
        <Link href={back} className="btn ghost sm">&larr; Back</Link>
        <button type="button" className="btn primary sm" onClick={() => print()}>Print or save PDF</button>
      </div>
      <header className="report-head">
        <div className="row gap"><Monogram /><div><div className="muted small">{project.name} {project.sampleId && <SyntheticBadge />}</div><h1>{title}</h1></div></div>
        <div className="report-meta small">
          <div><span className="muted">Period</span> {fmtPeriod(period)}</div>
          {team && user && <div><span className="muted">Account</span> {team}</div>}
          <div><span className="muted">Issued</span> {new Date().toISOString().slice(0, 10)}</div>
        </div>
      </header>

      <section className="report-kpis">
        <div><span>GPU-hours allocated</span><strong>{fmtN(gh)}</strong></div>
        <div><span>Charge</span><strong>{m(cost)}</strong></div>
        <div><span>SM active while allocated</span><strong>{fmtPct(sm)}</strong></div>
        <div className="bad"><span>Allocated but idle</span><strong>{m(idleCost)}</strong><small>{fmtN(idleGh)} GPU-hours</small></div>
      </section>

      <h2>Charges</h2>
      <table>
        <thead><tr><th>GPU class</th><th className="num">GPU-hours</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
        <tbody>{[...byClass].map(([c, r]) => <tr key={c}><td>{c}</td><td className="num">{fmtN(r.gh, 1)}</td><td className="num">{r.rate.toFixed(2)} {cur}/h</td><td className="num">{m(r.cost)}</td></tr>)}</tbody>
        <tfoot><tr><th>Total</th><td className="num">{fmtN(gh, 1)}</td><td /><td className="num strong">{m(cost)}</td></tr></tfoot>
      </table>

      {!user && users.size > 0 && (
        <>
          <h2>By user</h2>
          <table>
            <thead><tr><th>User</th><th className="num">Jobs</th><th className="num">GPU-hours</th><th className="num">Charge</th><th className="num">Idle spend</th></tr></thead>
            <tbody>{[...users].sort((x, y) => y[1].cost - x[1].cost).map(([u, r]) => <tr key={u}><td>{u}</td><td className="num">{r.n}</td><td className="num">{fmtN(r.gh)}</td><td className="num">{m(r.cost)}</td><td className="num">{m(r.idle)}</td></tr>)}</tbody>
          </table>
        </>
      )}

      {user && (
        <>
          <h2>Your jobs</h2>
          <table>
            <thead><tr><th>Job</th><th className="num">GPUs</th><th className="num">GPU-h</th><th className="num">SM mean</th><th className="num">Mem peak</th><th>Class</th></tr></thead>
            <tbody>{jobs.slice(0, 40).map(j => <tr key={j.id}><td className="mono small">{j.id}{j.name ? ` · ${j.name}` : ''}</td><td className="num">{j.gpus}</td><td className="num">{fmtN(j.gpuHours, 1)}</td><td className="num">{fmtPct(j.meanSm)}</td><td className="num">{Number.isFinite(j.fbPeakMiB) ? `${(j.fbPeakMiB / 1024).toFixed(0)} GiB` : '—'}</td><td>{CLASS_LABEL[j.cls]}</td></tr>)}</tbody>
          </table>
          {jobs.length > 40 && <p className="muted small">and {jobs.length - 40} more jobs in the CSV export.</p>}
        </>
      )}

      <h2>{user ? 'Top waste and how to fix it' : 'What would lower next month’s bill'}</h2>
      {fixes.length === 0 ? <p>No waste worth chasing this month.</p> : <ol className="report-fixes">{fixes.map((j: JobStats) => <li key={j.id}><strong className="mono">{j.id}</strong>{j.name ? ` (${j.name})` : ''}, {j.user}, {j.gpus}× {j.model}, {fmtN(j.gpuHours)} GPU-h. {j.rec.text} <em>{m(Math.max(j.idleCost, j.recoverableGpuHours * j.rate))} recoverable.</em></li>)}</ol>}

      <footer className="report-foot small muted">
        Charge = allocated GPU-hours × rate, whether or not the GPU did work. Idle = DCGM SM activity below {fmtPct(project.config.idleThreshold)} while allocated. SM activity is DCGM_FI_PROF_SM_ACTIVE{a.smProxy ? ' (GPU utilisation where profiling metrics were not collected, an upper bound)' : ''}. Rates are set by your platform team. {project.sampleId ? 'This statement uses synthetic data.' : ''} Generated with GPU Fleet Report, an independent project not affiliated with NVIDIA.
      </footer>
    </div>
  )
}
