import { useEffect, useMemo } from 'react'
import { compensation, FIX_LABEL } from './engine/analyze.ts'
import { toCsv } from './engine/csv.ts'
import { BUCKETS } from './engine/types.ts'
import { BucketBar, BucketLegend, BUCKET_LABEL } from './charts.tsx'
import { periodFromUrl } from './Project.tsx'
import { defaultPeriod, periodOptions, useAnalysis, useProject, withPeople } from './projectData.ts'
import { download, fmtMin, fmtMoney, fmtN, fmtPct, fmtPeriod, Link, signed, SyntheticBadge } from './ui.tsx'

export default function Report({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const opts = useMemo(() => periodOptions(ds), [ds])
  const def = useMemo(() => defaultPeriod(ds, opts), [ds, opts])
  const period = periodFromUrl(opts, def)
  const cfg = useMemo(() => project && ds ? withPeople(project.config, ds) : null, [project?.config, ds])
  const a = useAnalysis(ds, cfg ?? undefined, period)
  useEffect(() => { if (project) document.title = `On-call health review · ${project.name} · ${fmtPeriod(period)}` }, [project?.name, period])
  const pay = useMemo(() => a && cfg ? compensation(a.incidents, cfg, cfg.policy, project?.weeks ?? {}) : [], [a, cfg, project?.weeks])

  if (loading) return <div className="boot"><span className="spinner" /> Building the report</div>
  if (!project || !a || !cfg) return <section className="page narrow center"><h1>Team not found</h1><Link href="/app" className="btn primary">All teams</Link></section>
  const b = a.base, m = b.months
  const rota = b.people.filter(p => !p.excluded)
  const top = rota[0]
  const noise = new Set(a.fixes.flatMap(f => f.removed)).size
  const snaps = project.snapshots
  const [s0, s1] = [snaps.at(-2), snaps.at(-1)]
  const findings = [
    `${fmtN(b.total)} pages in ${fmtPeriod(period).toLowerCase() === 'all data' ? 'the imported history' : fmtPeriod(period)} (${fmtN(b.total / m, 1)} a month); ${fmtPct(b.buckets.sleep / Math.max(1, b.total))} landed in someone's sleep hours and ${fmtPct(b.buckets.business / Math.max(1, b.total))} in business hours.`,
    top ? `${top.name} has the highest burnout risk (${top.score}/100, ${top.band}): ${top.buckets.sleep} sleep interruptions, up to ${top.maxNights} bad nights in a row, ${top.weekendDays} days off interrupted, and ${fmtPct(top.share)} of pages against a fair share of ${fmtPct(top.fairShare)}.` : '',
    `Load fairness across the rotation: Gini ${b.giniPages.toFixed(2)} on page counts, ${b.giniBurden.toFixed(2)} when night and weekend pages are weighted heavier (0 is perfectly even).`,
    a.fixes.length ? `${fmtN(noise / m, 1)} pages a month (${fmtPct(noise / Math.max(1, b.total))}) come from alerts with a concrete fix. The top three alone remove ${fmtN(new Set(a.fixes.slice(0, 3).flatMap(f => f.removed)).size / m, 1)} a month.` : 'No alert met the noise thresholds this period.',
    `Median time to acknowledge ${fmtMin(b.ackP50)} (90th percentile ${fmtMin(b.ackP90)}); ${fmtN(b.neverAcked)} pages were never acknowledged.`,
  ].filter(Boolean)
  const csv = () => toCsv([['person', 'pages', ...BUCKETS.map(k => `${k}_pages`), 'longest_bad_night_run', 'days_off_interrupted', 'share', 'fair_share', 'burnout_score', 'band', 'ack_p50_min'],
    ...b.people.map(p => [p.name, p.pages, ...BUCKETS.map(k => p.buckets[k]), p.maxNights, p.weekendDays, Math.round(p.share * 1000) / 1000, Math.round(p.fairShare * 1000) / 1000, p.score, p.band, Number.isFinite(p.ackP50) ? Math.round(p.ackP50 * 10) / 10 : ''])])

  return (
    <article className="report">
      <div className="report-actions">
        <Link href={`/app/p/${id}${location.search}`} className="btn ghost">Back to the team</Link>
        <button type="button" className="btn outline" onClick={() => download(`oncall-review-${period}.csv`, csv())}>Download CSV</button>
        <button type="button" className="btn primary" onClick={() => print()}>Print or save as PDF</button>
      </div>
      <div className="eyebrow">On-call health review</div>
      <h1>{project.name}, {fmtPeriod(period)} {project.sampleId && <SyntheticBadge />}</h1>
      <p className="muted">{fmtN(b.total)} pages · {rota.length} people in rotation · sleep hours {String(cfg.sleepStart).padStart(2, '0')}:00 to {String(cfg.sleepEnd).padStart(2, '0')}:00 local · prepared {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
      <div className="kpis">
        <div className="kpi"><small>Pages per month</small><b>{fmtN(b.total / m, 1)}</b></div>
        <div className="kpi"><small>Sleep interruptions / month</small><b>{fmtN(b.buckets.sleep / m, 1)}</b></div>
        <div className="kpi"><small>Fairness (Gini)</small><b>{b.giniPages.toFixed(2)}</b></div>
        <div className="kpi"><small>Removable noise</small><b>{fmtPct(noise / Math.max(1, b.total))}</b></div>
      </div>
      <h2>Findings</h2>
      <ol>{findings.map((f, i) => <li key={i}>{f}</li>)}</ol>
      <h2>Load per person</h2>
      <BucketLegend />
      <div className="table-wrap"><table>
        <thead><tr><th>Person</th><th className="num">Pages</th><th style={{ minWidth: 120 }}>When</th>{BUCKETS.map(k => <th key={k} className="num">{BUCKET_LABEL[k]}</th>)}<th className="num">Share / fair</th><th className="num">Risk</th></tr></thead>
        <tbody>{b.people.map(p => <tr key={p.name}><th scope="row">{p.name}</th><td className="num">{p.pages}</td><td><BucketBar buckets={p.buckets} /></td>{BUCKETS.map(k => <td key={k} className="num">{p.buckets[k]}</td>)}<td className="num">{p.excluded ? '—' : `${fmtPct(p.share)} / ${fmtPct(p.fairShare)}`}</td><td className="num"><span className={`badge ${p.band}`}>{p.score} {p.band}</span></td></tr>)}</tbody>
      </table></div>
      <h2>Alerts to tune first</h2>
      {a.fixes.length ? <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Alert</th><th>Change</th><th className="num">Pages / mo removed</th><th className="num">At night</th></tr></thead>
        <tbody>{a.fixes.slice(0, 8).map((f, i) => <tr key={f.id}><td>{i + 1}</td><td><strong>{f.title}</strong><div className="muted tiny">{f.service} · {f.evidence}</div></td><td><strong>{FIX_LABEL[f.kind]}.</strong> <span className="small">{f.change}</span></td><td className="num">{fmtN(f.perMonth, 1)}</td><td className="num">{fmtN(f.sleepPerMonth, 1)}</td></tr>)}</tbody>
      </table></div> : <p className="muted">No alert met the noise thresholds.</p>}
      {s0 && s1 && <>
        <h2>Trend: {s0.label} to {s1.label}</h2>
        <ul>
          <li>Pages per month {fmtN(s0.pagesPerMonth, 1)} → {fmtN(s1.pagesPerMonth, 1)} ({signed(s1.pagesPerMonth - s0.pagesPerMonth, v => fmtN(v, 1))})</li>
          <li>Sleep interruptions per month {fmtN(s0.buckets.sleep / (s0.days / 30.44), 1)} → {fmtN(s1.buckets.sleep / (s1.days / 30.44), 1)}</li>
          <li>Fairness (Gini) {s0.giniPages.toFixed(2)} → {s1.giniPages.toFixed(2)}</li>
          <li>Removable noise per month {fmtN(s0.noisePerMonth, 1)} → {fmtN(s1.noisePerMonth, 1)}</li>
        </ul>
      </>}
      {pay.length > 0 && <>
        <h2>On-call pay and time off in lieu</h2>
        <p className="small muted">Policy: {fmtMoney(cfg.policy.stipendPerWeek, cfg.policy.currency)} per on-call week, {fmtMoney(cfg.policy.perOffHoursPage, cfg.policy.currency)} per evening or weekend page, {fmtMoney(cfg.policy.perSleepPage, cfg.policy.currency)} per sleep-hours page; {cfg.policy.toilPerSleepPage} h off per sleep page and {cfg.policy.toilPerWeekendDay} h per interrupted day off. Pages within {cfg.policy.groupMinutes} min count once.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Person</th><th className="num">Weeks</th><th className="num">Total</th><th className="num">Time off (h)</th></tr></thead>
          <tbody>{pay.map(r => <tr key={r.name}><th scope="row">{r.name}</th><td className="num">{r.weeks}</td><td className="num">{fmtMoney(r.total, cfg.policy.currency)}</td><td className="num">{fmtN(r.toilHours, 1)}</td></tr>)}</tbody>
        </table></div>
      </>}
      <p className="muted small" style={{ marginTop: 28 }}>Method: pages are bucketed in each person&rsquo;s local time (sleep first, then non-working days, then working hours, else evening). The burnout-risk score and noise rules are documented at {location.host}/docs. {project.sampleId ? 'This team is synthetic.' : ''}</p>
    </article>
  )
}
