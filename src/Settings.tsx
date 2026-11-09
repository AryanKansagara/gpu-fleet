import { useState } from 'react'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>) => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast('Saved', { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults for new teams</h2>
        <p className="muted small">Existing teams keep their own settings; change those on the team&rsquo;s Data &amp; people and Noisy alerts tabs.</p>
        <div className="inline-fields">
          <label className="field"><span>Default timezone</span><input value={d.tz} onChange={e => { try { new Intl.DateTimeFormat('en', { timeZone: e.target.value }); save({ tz: e.target.value }) } catch { setD({ ...d, tz: e.target.value }) } }} /></label>
          <label className="field"><span>Sleep hours start (hour)</span><input type="number" min="0" max="23.5" step="0.5" value={d.sleepStart} onChange={e => save({ sleepStart: Math.min(23.5, Math.max(0, Number(e.target.value))) })} /></label>
          <label className="field"><span>Sleep hours end (hour)</span><input type="number" min="0" max="23.5" step="0.5" value={d.sleepEnd} onChange={e => save({ sleepEnd: Math.min(23.5, Math.max(0, Number(e.target.value))) })} /></label>
          <label className="field"><span>Work starts (hour)</span><input type="number" min="0" max="23.5" step="0.5" value={d.workStart} onChange={e => save({ workStart: Number(e.target.value) })} /></label>
          <label className="field"><span>Work ends (hour)</span><input type="number" min="0" max="24" step="0.5" value={d.workEnd} onChange={e => save({ workEnd: Number(e.target.value) })} /></label>
          <label className="field"><span>Auto-resolved under (min)</span><input type="number" min="1" max="60" value={d.autoResolveMin} onChange={e => save({ autoResolveMin: Math.max(1, Number(e.target.value)) })} /></label>
          <label className="field"><span>Flapping window (min)</span><input type="number" min="5" max="1440" value={d.flapWindowMin} onChange={e => save({ flapWindowMin: Math.max(5, Number(e.target.value)) })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Teams live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: people, thresholds, fixes, snapshots and incident lists under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`oncall-health-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local teams?', `Removes ${list.length} team${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} teams`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all teams</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>6</kbd></dt><dd>Switch team sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Older / newer period</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a snapshot</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable quarterly report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a team page</dd></div>
        </dl>
      </div>
    </section>
  )
}
