import { useEffect, useMemo, useRef, useState } from 'react'
import { analyze, applyFixes, detectFixes, FIX_LABEL, type Fix } from './engine/analyze.ts'
import { SAMPLES, sampleConfig } from './engine/sample.ts'
import { BucketBar, BucketLegend, Heatmap, HeatLegend, ScoreRing } from './charts.tsx'
import { sampleIncidents } from './projectData.ts'
import { fmtN, Link } from './ui.tsx'

const HERO_PEOPLE = ['Priya Raman', 'Dana Okafor', 'Jun Park']

function useHero() {
  return useMemo(() => {
    const def = SAMPLES[0]
    const list = sampleIncidents(def.id)!
    const cfg = sampleConfig(def)
    const fixes = detectFixes(list, cfg)
    // The strongest fix for each of the three noisiest alerts.
    const picks: Fix[] = []
    for (const f of fixes) if (!picks.some(p => p.key === f.key) && picks.length < 3) picks.push(f)
    const base = analyze(list, cfg)
    return { list, cfg, fixes, picks, base }
  }, [])
}

export function Landing() {
  const { list, cfg, fixes, picks, base } = useHero()
  const [on, setOn] = useState<string[]>([])
  const touched = useRef(false)
  useEffect(() => {
    // Show it working once, unless the visitor gets there first.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setTimeout(() => { if (!touched.current) setOn([picks[0].id]) }, 2200)
    return () => clearTimeout(t)
  }, [picks])
  // Applying a fix applies every suggestion for that alert key (delay plus dedupe, for example).
  const applied = useMemo(() => fixes.filter(f => picks.some(p => on.includes(p.id) && p.key === f.key)).map(f => f.id), [on, fixes, picks])
  const now = useMemo(() => analyze(applyFixes(list, fixes, applied), cfg, { days: base.days }), [applied, list, fixes, cfg, base.days])
  const person = (a: typeof base, n: string) => a.people.find(p => p.name === n)!
  const max = Math.max(...HERO_PEOPLE.map(n => Math.max(...person(base, n).heat)))
  const sleepNow = useTween(now.buckets.sleep / now.months)
  const priya = person(now, 'Priya Raman')
  const scoreNow = useTween(priya.score)
  const pagesNow = useTween(now.total / now.months)

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <div className="eyebrow">For the quarterly on-call review</div>
            <h1>See who on-call is <span className="serif">really</span> waking up, then fix the alerts doing it.</h1>
            <p className="lede">Import a quarter of PagerDuty, Opsgenie or Rootly history. Get each person&rsquo;s sleep, evening and weekend interruptions, a fairness score for the rotation, and a ranked list of alert changes with the pages each one removes.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=payments" className="btn primary lg">Open the sample team</Link>
              <Link href="/app" className="btn outline lg">Import your history</Link>
            </div>
            <p className="hero-note">Runs in your browser. No account needed. Sample teams are synthetic.</p>
          </div>
          <div className="pager" aria-label="Live demo on a synthetic payments team">
            <div className="pager-bar"><i /><i /><i /><strong>Payments platform</strong><span>· synthetic · Jul to Oct 2026 · local time</span></div>
            <div className="pager-body">
              <div className="pager-kpis">
                <div className="kpi-mini"><small>Sleep pages / month</small><b>{fmtN(sleepNow)}{applied.length > 0 && <span className="delta">−{fmtN(base.buckets.sleep / base.months - now.buckets.sleep / now.months)}</span>}</b></div>
                <div className="kpi-mini"><small>All pages / month</small><b>{fmtN(pagesNow)}</b></div>
                <div className="kpi-mini row gap-sm"><div className="grow"><small>Priya&rsquo;s risk</small><b>{Math.round(scoreNow)}</b></div><ScoreRing score={priya.score} band={priya.band} /></div>
              </div>
              {HERO_PEOPLE.map(n => {
                const p = person(now, n), b = person(base, n)
                return (
                  <div className="heat-person" key={n}>
                    <div className="heat-person-head"><b>{n}</b><span className="muted tab-nums">{fmtN(p.buckets.sleep)} sleep · {fmtN(p.pages)} total</span></div>
                    <Heatmap heat={p.heat} before={applied.length ? b.heat : undefined} max={max} sleepStart={cfg.sleepStart} sleepEnd={cfg.sleepEnd} label={n} />
                  </div>
                )
              })}
              <div className="fix-toggles" role="group" aria-label="Suggested alert fixes">
                {picks.map(f => {
                  const active = on.includes(f.id)
                  const removed = new Set(fixes.filter(x => x.key === f.key).flatMap(x => x.removed)).size / base.months
                  return (
                    <label key={f.id} className={`fix-toggle${active ? ' on' : ''}`}>
                      <span className="switch"><input type="checkbox" checked={active} onChange={() => { touched.current = true; setOn(o => active ? o.filter(x => x !== f.id) : [...o, f.id]) }} /><span /></span>
                      <span className="ft-text"><b>{f.title}</b><small>{FIX_LABEL[f.kind]}</small></span>
                      <span className="ft-n">−{fmtN(removed)}/mo</span>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">What on-call engineers keep saying</div>
          <h2>The pager problem is rarely the incidents. It is everything else that pages.</h2>
        </div>
        <div className="quotes">
          <figure className="quote"><blockquote>&ldquo;Is this normal?&rdquo;</blockquote><p>A sysadmin paged through four channels at once (pager, chat, email and a second chat tool) with a 15-minute response target. The most upvoted advice: one paging channel, and only alerts someone can act on.</p><span className="src">Paraphrased from a popular r/sysadmin thread</span></figure>
          <figure className="quote"><blockquote>&ldquo;Alert fatigue is out of control.&rdquo;</blockquote><p>The fixes that worked were boring: alert dependencies, escalation delays so transient spikes resolve before anyone wakes, and deleting anything that is not actionable.</p><span className="src">Paraphrased from r/Monitoring</span></figure>
          <figure className="quote"><blockquote>&ldquo;Four of every five weekends.&rdquo;</blockquote><p>A manager asked how to push back on one engineer being on call almost every weekend. Without numbers on who carries the load, the conversation goes nowhere.</p><span className="src">Paraphrased from r/askmanagers</span></figure>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">The workflow</div>
          <h2>From an export to a leadership-ready review in one sitting.</h2>
        </div>
        <div className="features">
          {FEATURES.map(f => <article className="feature" key={f.t}><div className="ico" aria-hidden="true">{f.i}</div><h3>{f.t}</h3><p>{f.b}</p></article>)}
        </div>
      </section>

      <section className="section">
        <div className="grid-2">
          <div>
            <div className="eyebrow">Transparent by design</div>
            <h2>A burnout-risk score you can defend in the review.</h2>
            <p className="muted">No black box. Four parts, each capped, computed from the person&rsquo;s own local time and working hours. Every number links back to the pages behind it.</p>
            <Link href="/docs#score" className="btn ghost">How the score works</Link>
          </div>
          <div className="panel tint">
            <div className="score-steps">
              <div className="score-step"><b>40</b><p>Sleep interruptions per week, ×10</p></div>
              <div className="score-step"><b>25</b><p>Consecutive bad nights in a row</p></div>
              <div className="score-step"><b>20</b><p>Weekend and day-off interruptions</p></div>
              <div className="score-step"><b>15</b><p>Evening pages per week, ×3</p></div>
            </div>
            <hr />
            <div className="stack-sm">
              {base.people.slice(0, 4).map(p => (
                <div key={p.name} className="row gap">
                  <ScoreRing score={p.score} band={p.band} />
                  <div className="grow"><div className="row between small"><span>{p.name}</span><span className="muted">{p.pages} pages</span></div><BucketBar buckets={p.buckets} /></div>
                </div>
              ))}
              <BucketLegend />
            </div>
          </div>
        </div>
      </section>

      <div className="cta-band">
        <div className="cta-inner">
          <div><h2>Bring last quarter&rsquo;s pages.</h2><p>PagerDuty, Opsgenie, Rootly or any CSV. Ten minutes to your first report.</p></div>
          <div className="row gap wrap"><Link href="/app" className="btn primary lg">Start a review</Link><Link href="/docs" className="btn lg" style={{ color: '#fff', background: '#ffffff1f' }}>Export guides</Link></div>
        </div>
      </div>
      <div className="section" style={{ paddingTop: 30 }}><HeatLegend /></div>
    </>
  )
}

const ico = (d: string) => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
const FEATURES = [
  { t: 'Import what you already have', b: 'PagerDuty CSV or REST API, Opsgenie, Rootly, or any CSV. Format detection, column mapping and a validation report with line numbers.', i: ico('M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2') },
  { t: 'Load per person, in their hours', b: 'Each person’s timezone and working hours split pages into business hours, evenings, sleep and weekends. Ack and resolve distributions included.', i: ico('M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z') },
  { t: 'Fairness you can show', b: 'Gini coefficient across the rotation and each person’s share against a fair share. Spot the person quietly absorbing swaps.', i: ico('M3 21h18M6 17V9m6 8V5m6 12v-5') },
  { t: 'Tune these alerts first', b: 'Flapping, duplicates, auto-resolved blips, never-acked and non-actionable alerts, ranked by the pages per month each change removes.', i: ico('M4 6h16M7 12h10M10 18h4') },
  { t: 'Rotation simulator', b: 'Team size, shift length, primary and secondary, or follow-the-sun. Projected pages and sleep interruptions per person before you change anything.', i: ico('M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4') },
  { t: 'Report, pay and history', b: 'A printable quarterly report and CSV for leadership, an editable pay and time-off-in-lieu policy, and snapshots to prove the tuning worked.', i: ico('M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6') },
]

function useTween(target: number, ms = 650) {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(target); from.current = target; return }
    const a = from.current, t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const e = 1 - (1 - k) ** 3
      const cur = a + (target - a) * e
      setV(cur)
      from.current = cur
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

