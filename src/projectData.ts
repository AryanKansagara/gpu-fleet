import { useEffect, useMemo, useState } from 'react'
import { analyze, applyFixes, DEFAULT_PERSON, detectFixes, escalationRate, periods, slicePeriod, snapshot, type RotaInput } from './engine/analyze.ts'
import { SAMPLES, generate, sampleConfig } from './engine/sample.ts'
import type { Config, Incident } from './engine/types.ts'
import { blankConfig, getData, getDefaults, getProjects, saveProject, useProjects, uuid, type Dataset, type Project } from './store.ts'
import { fmtPeriod } from './ui.tsx'

const sampleCache = new Map<string, Incident[]>()
export function sampleIncidents(id: string): Incident[] | null {
  const def = SAMPLES.find(s => s.id === id)
  if (!def) return null
  if (!sampleCache.has(id)) sampleCache.set(id, generate(def))
  return sampleCache.get(id)!
}

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const list = sampleIncidents(sampleId)!
  const config = sampleConfig(def)
  // A closed quarter and two months, so History has something to compare.
  const snapshots = ['2026-Q3', '2026-09', '2026-10'].map(p => snapshot(list, config, p, uuid(), fmtPeriod(p)))
  const now = Date.now()
  return saveProject({
    id: uuid(), name: def.name, createdAt: now, updatedAt: now, config, snapshots, sampleId,
    imports: [{ id: uuid(), kind: 'generic-csv', fileName: 'synthetic incidents (Jul to Oct 2026)', rows: list.length, skipped: 0, at: now }],
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, config: blankConfig(), snapshots: [], imports: [] })
}

/** Adds anyone who appears in the data but not in the people list, with the team's default timezone. */
export function withPeople(cfg: Config, list: Incident[]): Config {
  const missing = [...new Set(list.map(i => i.person))].filter(n => n !== 'Unassigned' && !cfg.people[n])
  if (!missing.length) return cfg
  const d = getDefaults()
  return { ...cfg, people: { ...cfg.people, ...Object.fromEntries(missing.map(n => [n, { ...DEFAULT_PERSON, workStart: d.workStart, workEnd: d.workEnd, tz: cfg.defaultTz }])) } }
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleIncidents(project.sampleId) ?? []); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? []) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey])
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  const setConfig = (patch: Partial<Config>) => project && saveProject({ ...project, config: { ...project.config, ...patch } })
  return { loading: list === null || (project !== null && ds === null), project, ds, update, setConfig }
}

/** Everything a project page needs for one period, before and after the applied fixes. */
export function useAnalysis(ds: Incident[] | null, cfg: Config | undefined, period: string) {
  return useMemo(() => {
    if (!ds || !cfg) return null
    const sliced = period === 'all' ? { incidents: ds, days: undefined } : slicePeriod(ds, period)
    const span = sliced.days ? { days: sliced.days } : undefined
    const fixes = detectFixes(sliced.incidents, cfg, span)
    const after = applyFixes(sliced.incidents, fixes, cfg.applied)
    return {
      incidents: sliced.incidents, span, fixes, after,
      base: analyze(sliced.incidents, cfg, span),
      fixed: cfg.applied.length ? analyze(after, cfg, span) : null,
    }
  }, [ds, cfg, period])
}

/** Latest quarter the data fully covers (within a week of its end), else the latest period with data. */
export function defaultPeriod(ds: Incident[] | null, opts: string[]): string {
  if (!ds?.length) return 'all'
  const last = ds.reduce((m, i) => Math.max(m, i.created), 0)
  const q = opts.find(p => /Q/.test(p) && Date.UTC(+p.slice(0, 4), +p.slice(-1) * 3, 1) - last < 7 * 86400000)
  return q ?? opts[1] ?? 'all'
}

export const periodOptions = (ds: Incident[] | null) => ds?.length ? ['all', ...periods(ds, 'quarter').reverse(), ...periods(ds, 'month').reverse()] : ['all']

export function defaultRota(cfg: Config, list: Incident[]): RotaInput {
  const n = Object.values(cfg.people).filter(p => !p.excluded).length || 4
  return { mode: 'single', size: n, shiftDays: 7, tz: cfg.defaultTz, regions: [cfg.defaultTz, cfg.defaultTz.startsWith('America') ? 'Europe/London' : 'America/New_York'], escalationRate: Math.round(escalationRate(list) * 100) / 100 }
}
