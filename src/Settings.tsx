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
        <h2>Defaults for new clusters</h2>
        <p className="muted small">Existing clusters keep their own thresholds and rates; change those on the cluster&rsquo;s Chargeback and Policy pack tabs.</p>
        <div className="inline-fields">
          <label className="field"><span>Idle threshold (SM active)</span><input type="number" min="0.005" max="0.5" step="0.01" value={d.idleThreshold} onChange={e => save({ idleThreshold: Math.min(0.5, Math.max(0.005, Number(e.target.value))) })} /></label>
          <label className="field"><span>Idle timeout (hours)</span><input type="number" min="0.5" max="72" step="0.5" value={d.idleTimeoutHours} onChange={e => save({ idleTimeoutHours: Math.min(72, Math.max(0.5, Number(e.target.value))) })} /></label>
          <label className="field"><span>Time bucket for imports</span><select value={d.step} onChange={e => save({ step: Number(e.target.value) })}>{[[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="field"><span>Currency</span><select value={d.currency} onChange={e => save({ currency: e.target.value })}>{['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD'].map(c => <option key={c}>{c}</option>)}</select></label>
        </div>
        <h3 className="small strong">Default $/GPU-hour</h3>
        <div className="inline-fields">
          {Object.entries(d.rates).map(([k, v]) => <label key={k} className="field"><span>{k}</span><input type="number" min="0" step="0.05" value={v} onChange={e => save({ rates: { ...d.rates, [k]: Math.max(0, Number(e.target.value)) } })} /></label>)}
          <label className="field"><span>Other GPUs</span><input type="number" min="0" step="0.05" value={d.defaultRate} onChange={e => save({ defaultRate: Math.max(0, Number(e.target.value)) })} /></label>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Illustrative defaults (November 2026), not quotes. Use your amortised on-prem cost or your contract&rsquo;s cloud rate.</p>
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
        <p>Clusters live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: thresholds, rates, the import log, monthly snapshots and telemetry under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`gpu-fleet-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local clusters?', `Removes ${list.length} cluster${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} clusters`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all clusters</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch cluster sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Older / newer month</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save a monthly snapshot</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a cluster page</dd></div>
        </dl>
      </div>
    </section>
  )
}
