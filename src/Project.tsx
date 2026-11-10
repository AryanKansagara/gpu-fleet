import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { snapshot, type Analysis } from './engine/analyze.ts'
import type { Config } from './engine/types.ts'
import { defaultPeriod, periodOptions, useAnalysis, useProject } from './projectData.ts'
import { uuid, type Dataset, type Project } from './store.ts'
import { Empty, fmtPeriod, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

const Tabs = lazy(() => import('./Tabs.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['overview', 'Overview'], ['jobs', 'Jobs'], ['teams', 'Chargeback'], ['users', 'Users'], ['policies', 'Policy pack'], ['history', 'History'], ['data', 'Data']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  ds: Dataset
  cfg: Config
  period: string
  a: Analysis
  setConfig(p: Partial<Config>): void
  update(p: Partial<Project>): void
}

export const periodFromUrl = (opts: string[], def: string) => {
  const q = new URLSearchParams(location.search).get('p')
  return q && opts.includes(q) ? q : def
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, setConfig, update } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const opts = useMemo(() => periodOptions(ds), [ds])
  const def = useMemo(() => defaultPeriod(ds), [ds])
  const period = periodFromUrl(opts, def)
  const cfg = project?.config
  const a = useAnalysis(ds, cfg, period)
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · GPU Fleet Report` }, [project?.name])

  const q = period === def ? '' : `?p=${period}`
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}${q}`, { keepScroll: true })
  const setPeriod = (p: string) => go(`${location.pathname}?p=${p}`, { replace: true, keepScroll: true })

  const saveSnapshot = () => {
    if (!project || !a || period === 'all') { toast('Pick a month to snapshot', { tone: 'error' }); return }
    const prev = project.snapshots.find(s => s.period === period)
    const snap = snapshot(a, period, uuid(), fmtPeriod(period), prev?.note)
    const snapshots = [...project.snapshots.filter(s => s.period !== period), snap].sort((x, y) => x.period.localeCompare(y.period))
    void update({ snapshots })
    toast(prev ? `Replaced the ${fmtPeriod(period)} snapshot` : `Saved a snapshot of ${fmtPeriod(period)}`, { tone: 'ok', undo: () => void update({ snapshots: project.snapshots }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 's') saveSnapshot()
      else if (e.key === '[' || e.key === ']') {
        const i = opts.indexOf(period)
        const j = e.key === '[' ? i + 1 : i - 1
        if (opts[j]) setPeriod(opts[j])
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Joining jobs to GPU telemetry</div>
  if (!project) return (
    <section className="page narrow center">
      <Empty title="Cluster not found"><p className="muted">It may have been deleted, or it lives on another device.</p><Link href="/app" className="btn primary">All clusters</Link></Empty>
    </section>
  )
  const empty = !ds?.fleet?.n

  return (
    <section className="page">
      <div className="proj-head">
        <div>
          <div className="eyebrow"><Link href="/app">Clusters</Link></div>
          <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          {a && <p className="muted small" style={{ margin: 0 }}>{a.gpus} GPUs · {a.jobs.length.toLocaleString()} jobs · {fmtPeriod(period)}</p>}
        </div>
        {!empty && (
          <div className="toolbar">
            <label className="sr-only" htmlFor="period">Period</label>
            <select id="period" value={period} onChange={e => setPeriod(e.target.value)}>
              {opts.map(p => <option key={p} value={p}>{fmtPeriod(p)}</option>)}
            </select>
            <button type="button" className="btn outline" onClick={saveSnapshot} title="Save a monthly snapshot (S)">Save snapshot</button>
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Cluster sections">
        {TABS.map(([t, l], i) => <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}${q}`} aria-current={t === tab ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>
      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {tab === 'data' || empty || !a
          ? <DataTab project={project} ds={ds!} update={update} setConfig={setConfig} />
          : <Tabs tab={tab} project={project} ds={ds!} cfg={cfg!} period={period} a={a} setConfig={setConfig} update={update} />}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Older / newer month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot of this month</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
