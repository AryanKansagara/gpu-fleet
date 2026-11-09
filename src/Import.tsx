import { useMemo, useRef, useState } from 'react'
import { validTz } from './engine/analyze.ts'
import { applyLogEntries, autoMap, detectCsvFormat, FIELDS, FORMATS, incidentsToCsv, mergeIncidents, parseCsv, parseJson, validate, type Format, type LogEntry, type Mapping } from './engine/csv.ts'
import type { Config, Incident, PersonCfg } from './engine/types.ts'
import { createBlankProject, withPeople } from './projectData.ts'
import { putData, saveProject, uuid, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, toast } from './ui.tsx'

interface Pending { id: string; name: string; format: Format; csv: { rows: string[][]; lines: number[] }; map: Mapping; logEntries?: LogEntry[] }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ZONES = (() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone') } catch { return ['UTC', 'America/New_York', 'Europe/London'] } })()
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
const fromHhmm = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) + (m || 0) / 60 }

export default function DataTab({ project, ds, cfg, update, setConfig }: { project: Project; ds: Incident[]; cfg: Config; update(p: Partial<Project>): void; setConfig(p: Partial<Config>): void }) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 100_000_000) { toast(`${f.name} is over 100 MB. Export one quarter at a time.`, { tone: 'error' }); continue }
      const text = await f.text()
      try {
        if (/^\s*[[{]/.test(text)) {
          const j = parseJson(text)
          if (j.format === 'pagerduty-log') { next.push({ id: uuid(), name: f.name, format: j.format, csv: j.csv, map: {}, logEntries: j.logEntries }); continue }
          if (j.csv.rows.length < 2) { toast(`${f.name} has no incidents in it.`, { tone: 'error' }); continue }
          next.push({ id: uuid(), name: f.name, format: j.format, csv: j.csv, map: autoMap(j.csv.rows[0]) })
        } else {
          const csv = parseCsv(text)
          if (csv.rows.length < 2) { toast(`${f.name} has no data rows.`, { tone: 'error' }); continue }
          next.push({ id: uuid(), name: f.name, format: detectCsvFormat(csv.rows[0]), csv, map: autoMap(csv.rows[0]) })
        }
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  /** Samples are read-only: importing into one starts a new team. */
  const target = async () => project.sampleId ? createBlankProject('My team') : project

  const commit = async (p: Pending, incidents: Incident[], skipped: number) => {
    const t = await target()
    const base = project.sampleId ? [] : ds
    const merged = mergeIncidents(base, incidents)
    await putData(t.id, merged)
    const meta = { id: uuid(), kind: p.format, fileName: p.name, rows: incidents.length, skipped, at: Date.now() }
    const config = withPeople(project.sampleId ? t.config : cfg, merged)
    await saveProject({ ...t, config, imports: [...(project.sampleId ? [] : project.imports), meta], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Imported ${incidents.length.toLocaleString()} pages${skipped ? `, skipped ${skipped}` : ''}`, { tone: 'ok' })
    if (project.sampleId) go(`/app/p/${t.id}/data`)
  }

  const enrich = async (p: Pending) => {
    const r = applyLogEntries(ds, p.logEntries ?? [])
    if (!r.matched) { toast('None of these log entries match imported incidents. Import /incidents first.', { tone: 'error' }); return }
    await putData(project.id, r.incidents)
    update({ config: withPeople(cfg, r.incidents), imports: [...project.imports, { id: uuid(), kind: p.format, fileName: p.name, rows: r.matched, skipped: 0, at: Date.now() }] })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Updated ${r.matched} incidents from log entries`, { tone: 'ok' })
  }

  const setPerson = (name: string, patch: Partial<PersonCfg>) => setConfig({ people: { ...cfg.people, [name]: { ...cfg.people[name], ...patch } } })
  const [newName, setNewName] = useState('')
  const people = Object.entries(cfg.people).sort((a, b) => a[0].localeCompare(b[0]))

  return (
    <>
      {project.dataMissing && <div className="banner warn"><span><strong>This team&rsquo;s incident list is on another device.</strong> People, fixes and snapshots synced; lists over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stay where they were imported. Re-import here to recompute.</span></div>}
      {!ds.length && !pending.length && (
        <div className="banner"><span><strong>Start here.</strong> Export a quarter of incidents or alerts from your paging tool (<Link href="/docs">exact steps</Link>), then drop the file below.</span></div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Import</h2><span className="muted small">PagerDuty CSV or API JSON · Opsgenie CSV · Rootly CSV or API JSON · any CSV</span></div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new team. Want to rehearse? <button type="button" className="linkish" onClick={() => download(`${project.sampleId}-incidents.csv`, incidentsToCsv(ds))}>Download the sample as CSV</button> and drop it back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose CSV or JSON files to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ? 'Reading files' : 'Drop exports here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>Parsed in your browser. Re-importing the same incidents updates them by ID instead of duplicating.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.json" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>

      {pending.map(p => <PendingFile key={p.id} p={p} hasData={ds.length > 0} onChange={n => setPending(x => x.map(y => y.id === p.id ? n : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} onEnrich={enrich} />)}

      <div className="panel">
        <div className="panel-head"><h2>People and working hours</h2><span className="muted small">Pages are bucketed in each person&rsquo;s own timezone</span></div>
        <div className="inline-fields">
          <label className="field"><span>Team default timezone</span><input list="tz-list" value={cfg.defaultTz} onChange={e => validTz(e.target.value) && setConfig({ defaultTz: e.target.value })} /></label>
          <label className="field"><span>Sleep hours start</span><input type="time" value={hhmm(cfg.sleepStart)} onChange={e => setConfig({ sleepStart: fromHhmm(e.target.value) })} /></label>
          <label className="field"><span>Sleep hours end</span><input type="time" value={hhmm(cfg.sleepEnd)} onChange={e => setConfig({ sleepEnd: fromHhmm(e.target.value) })} /></label>
        </div>
        <datalist id="tz-list">{ZONES.map(z => <option key={z} value={z} />)}</datalist>
        {people.length === 0 ? <p className="muted small">People appear here after the first import. You can also add them by hand, for example someone who was on the rotation but never got paged.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Person</th><th>Timezone</th><th>Work starts</th><th>Work ends</th><th>Working days</th><th>In rotation</th></tr></thead>
              <tbody>{people.map(([name, pc]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td><input className={`table-input${validTz(pc.tz) ? '' : ' error'}`} list="tz-list" defaultValue={pc.tz} aria-label={`Timezone for ${name}`} onBlur={e => { if (validTz(e.target.value)) setPerson(name, { tz: e.target.value }); else { toast(`"${e.target.value}" is not a timezone. Use an IANA name like Europe/London.`, { tone: 'error' }); e.target.value = pc.tz } }} style={{ minWidth: 170 }} /></td>
                  <td><input className="table-input" type="time" value={hhmm(pc.workStart)} aria-label={`Work start for ${name}`} onChange={e => setPerson(name, { workStart: fromHhmm(e.target.value) })} /></td>
                  <td><input className="table-input" type="time" value={hhmm(pc.workEnd)} aria-label={`Work end for ${name}`} onChange={e => setPerson(name, { workEnd: fromHhmm(e.target.value) })} /></td>
                  <td><div className="row" style={{ gap: 3 }}>{DAYS.map((d, i) => (
                    <label key={d} title={d} className="tiny" style={{ display: 'grid', justifyItems: 'center', cursor: 'pointer' }}>
                      <span className="muted">{d[0]}</span>
                      <input type="checkbox" checked={pc.workDays.includes(i)} aria-label={`${name} works ${d}`} onChange={e => setPerson(name, { workDays: e.target.checked ? [...pc.workDays, i].sort() : pc.workDays.filter(x => x !== i) })} />
                    </label>
                  ))}</div></td>
                  <td><span className="switch"><input type="checkbox" checked={!pc.excluded} aria-label={`${name} is in the rotation`} onChange={e => setPerson(name, { excluded: !e.target.checked })} /><span /></span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <form className="row gap-sm" style={{ marginTop: 12, maxWidth: 420 }} onSubmit={e => { e.preventDefault(); const n = newName.trim(); if (!n || cfg.people[n]) return; setPerson(n, { tz: cfg.defaultTz, workStart: 9, workEnd: 17.5, workDays: [1, 2, 3, 4, 5] }); setNewName('') }}>
          <input placeholder="Add a person" value={newName} onChange={e => setNewName(e.target.value)} aria-label="New person name" />
          <button className="btn outline" disabled={!newName.trim()}>Add</button>
        </form>
      </div>

      {(project.imports.length > 0 || ds.length > 0) && (
        <div className="panel">
          <div className="panel-head"><h2>Imported data</h2><span className="muted small">{ds.length.toLocaleString()} pages{rawSize ? ` · ${(rawSize / 1e6).toFixed(2)} MB` : ''}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Format</th><th className="num">Rows</th><th className="num">Skipped</th><th>When</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{FORMATS[i.kind] ?? i.kind}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td><td className="small">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="muted small">{sync.user
            ? rawSize > RAW_SYNC_LIMIT ? `This list is over ${(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB, so it stays on this device. People, thresholds, fixes and snapshots still sync.` : 'Synced to your account with people, thresholds, fixes and snapshots.'
            : 'Stored in this browser only. Sign in to sync across devices.'}</p>
          <div className="row gap wrap">
            <button type="button" className="btn sm outline" onClick={() => download(`${project.name.replace(/\W+/g, '-').toLowerCase()}-incidents.csv`, incidentsToCsv(ds))}>Download normalized CSV</button>
            {!project.sampleId && <button type="button" className="btn sm danger-ghost" onClick={async () => {
              if (!(await ask('Clear imported data?', 'Removes every imported page from this team on this device. People, settings and snapshots stay. You can undo for a few seconds.', 'Clear data'))) return
              const before = ds, imports = project.imports
              await putData(project.id, [])
              update({ imports: [] })
              toast('Cleared imported data', { undo: async () => { await putData(project.id, before); update({ imports }) } })
            }}>Clear imported data</button>}
          </div>
        </div>
      )}
    </>
  )
}

function PendingFile({ p, hasData, onChange, onCancel, onCommit, onEnrich }: { p: Pending; hasData: boolean; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, rows: Incident[], skipped: number): Promise<void>; onEnrich(p: Pending): Promise<void> }) {
  const v = useMemo(() => p.logEntries ? null : validate(p.csv, p.map, p.format), [p])
  const [busy, setBusy] = useState(false)
  const headers = p.csv.rows[0] ?? []
  if (p.logEntries) return (
    <div className="panel">
      <div className="panel-head"><h2 className="break">{p.name}</h2><span className="badge">{FORMATS[p.format]}</span></div>
      <p>{p.logEntries.length.toLocaleString()} log entries. They add who was actually notified, when they acknowledged, and whether an integration resolved the incident.</p>
      {!hasData && <p className="warn-text small">Import the matching /incidents JSON first, then these entries.</p>}
      <div className="row gap"><button type="button" className="btn primary" disabled={!hasData || busy} onClick={async () => { setBusy(true); await onEnrich(p); setBusy(false) }}>Enrich incidents</button><button type="button" className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  )
  const errors = v!.issues.filter(i => i.level === 'error')
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="break">{p.name}</h2>
        <label className="row gap-sm small">Format
          <select value={p.format} style={{ width: 'auto' }} onChange={e => onChange({ ...p, format: e.target.value as Format })}>
            {(Object.keys(FORMATS) as Format[]).filter(f => f !== 'pagerduty-log').map(f => <option key={f} value={f}>{FORMATS[f]}</option>)}
          </select>
        </label>
      </div>
      <h3 className="small strong">Column mapping</h3>
      <div className="map-grid">
        {FIELDS.map(f => (
          <label key={f.key} className="field"><span>{f.label}{f.required ? ' *' : ''}</span>
            <select value={p.map[f.key] ?? ''} onChange={e => { const map = { ...p.map }; if (e.target.value === '') delete map[f.key]; else map[f.key] = Number(e.target.value); onChange({ ...p, map }) }}>
              <option value="">Not mapped</option>
              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
      </div>
      <h3 className="small strong" style={{ marginTop: 8 }}>Validation</h3>
      <p className="small">
        <strong className="good-text">{v!.incidents.length.toLocaleString()} pages ready</strong> of {v!.total.toLocaleString()} rows
        {v!.skipped > 0 && <>, <strong className="error">{v!.skipped} skipped</strong></>}
        {v!.issues.length > errors.length && <>, {v!.issues.length - errors.length} warnings</>}.
        {v!.incidents.length > 0 && <> People found: {new Set(v!.incidents.map(i => i.person)).size}. Range {new Date(v!.incidents.reduce((m, i) => Math.min(m, i.created), Infinity)).toISOString().slice(0, 10)} to {new Date(v!.incidents.reduce((m, i) => Math.max(m, i.created), 0)).toISOString().slice(0, 10)}.</>}
      </p>
      {v!.issues.length > 0 && (
        <div className="issues" role="log" aria-label="Validation issues">
          {v!.issues.slice(0, 200).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">{p.format.endsWith('json') ? 'record' : 'line'} {i.line}</span><span>{i.message}</span></div>)}
          {v!.issues.length > 200 && <div><span className="ln" /><span className="muted">and {v!.issues.length - 200} more</span></div>}
        </div>
      )}
      <div className="row gap" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={!v!.incidents.length || busy} onClick={async () => { setBusy(true); await onCommit(p, v!.incidents, v!.skipped); setBusy(false) }}>Import {v!.incidents.length.toLocaleString()} pages</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
