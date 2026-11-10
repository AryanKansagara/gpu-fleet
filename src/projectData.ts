import { useEffect, useMemo, useState } from 'react'
import { analyze, fullWindow, monthWindow, months, snapshot, type Analysis } from './engine/analyze.ts'
import { jobsFromLabels } from './engine/parse.ts'
import { generate, SAMPLE_HISTORY, SAMPLE_MONTH, SAMPLES } from './engine/sample.ts'
import { DEFAULT_CONFIG, type Config } from './engine/types.ts'
import { blankConfig, getData, getProjects, saveProject, useProjects, uuid, type Dataset, type Project } from './store.ts'
import { fmtPeriod } from './ui.tsx'

const sampleCache = new Map<string, Dataset>()
export function sampleData(id: string, month = SAMPLE_MONTH): Dataset | null {
  if (!SAMPLES.some(s => s.id === id)) return null
  const k = id + month
  if (!sampleCache.has(k)) sampleCache.set(k, generate(id, month))
  return sampleCache.get(k)!
}

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const config: Config = { ...DEFAULT_CONFIG, applied: { ...DEFAULT_CONFIG.applied } }
  // Two earlier months so History has a trend and something to compare against.
  const snapshots = [...SAMPLE_HISTORY, SAMPLE_MONTH].map(m => {
    const d = sampleData(sampleId, m)!
    return snapshot(analyze(d.fleet!, d.jobs, config), m, uuid(), fmtPeriod(m))
  })
  const d = sampleData(sampleId)!
  const now = Date.now()
  return saveProject({
    id: uuid(), name: def.name.replace(' (synthetic)', ''), createdAt: now, updatedAt: now, config, snapshots, sampleId,
    imports: [
      { id: uuid(), kind: 'prom-json', fileName: 'synthetic DCGM metrics, October 2026', rows: d.fleet!.tracks.length * d.fleet!.n * 4, skipped: 0, at: now },
      { id: uuid(), kind: def.kind === 'slurm' ? 'sacct' : 'k8s-json', fileName: def.kind === 'slurm' ? 'synthetic sacct, October 2026' : 'synthetic kubectl pods', rows: d.jobs.length, skipped: 0, at: now },
    ],
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, config: blankConfig(), snapshots: [], imports: [] })
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleData(project.sampleId) ?? { fleet: null, jobs: [] }); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? { fleet: null, jobs: [] }) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey])
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  const setConfig = (patch: Partial<Config>) => project && saveProject({ ...project, config: { ...project.config, ...patch } })
  return { loading: list === null || (project !== null && ds === null), project, ds, update, setConfig }
}

/** Jobs to analyse: the scheduler export if there is one, else jobs read from metric labels. */
export const effectiveJobs = (ds: Dataset) => ds.jobs.length ? ds.jobs : ds.fleet ? jobsFromLabels(ds.fleet) : []

export function useAnalysis(ds: Dataset | null, cfg: Config | undefined, period: string): Analysis | null {
  return useMemo(() => {
    if (!ds?.fleet?.n || !cfg) return null
    const w = period === 'all' ? fullWindow(ds.fleet) : monthWindow(ds.fleet, period)
    if (w.b1 <= w.b0) return null
    return analyze(ds.fleet, effectiveJobs(ds), cfg, w)
  }, [ds, cfg, period])
}

export const periodOptions = (ds: Dataset | null) => ds?.fleet?.n ? [...months(ds.fleet).reverse(), 'all'] : ['all']

/** Latest month with at least two weeks of data, else everything. */
export function defaultPeriod(ds: Dataset | null): string {
  if (!ds?.fleet?.n) return 'all'
  const f = ds.fleet
  const ms = months(f)
  for (const m of [...ms].reverse()) {
    const w = monthWindow(f, m)
    if ((w.b1 - w.b0) * f.step >= 14 * 86400) return m
  }
  return ms.length === 1 ? ms[0] : 'all'
}
