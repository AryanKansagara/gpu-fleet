import { useEffect, useMemo, useState } from 'react'
import type { Analysis, Heat } from './engine/analyze.ts'
import { Heatmap, HeatLegend } from './Heatmap.tsx'
import { Counter, useTween } from './motion.tsx'
import { fmtPct, Link } from './ui.tsx'

interface Demo { a: Analysis; before: Heat; after: Heat }

/** The hero runs the real engine on the synthetic Helix cluster: one week, 64 H100s. */
function useDemo() {
  const [demo, setDemo] = useState<Demo | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const [{ generate }, { analyze, heatmap, monthWindow }, { DEFAULT_CONFIG }] = await Promise.all([import('./engine/sample.ts'), import('./engine/analyze.ts'), import('./engine/types.ts')])
      const { fleet, jobs } = generate('helix')
      const m = monthWindow(fleet, '2026-10')
      const w = { b0: m.b0 + 7 * 96, b1: m.b0 + 14 * 96 } // 8 to 14 October, 15-minute buckets
      const a = analyze(fleet, jobs, DEFAULT_CONFIG, w)
      if (live) setDemo({ a, before: heatmap(fleet, a.sim.before, w, 112), after: heatmap(fleet, a.sim.after, w, 112) })
    }, 60)
    return () => { live = false; clearTimeout(t) }
  }, [])
  return demo
}

function usePlayhead(run: boolean) {
  const [p, setP] = useState(0)
  useEffect(() => {
    if (!run || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => { setP(((now - start) / 14000) % 1); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run])
  return p
}

export function Landing() {
  const demo = useDemo()
  const [on, setOn] = useState(false)
  const t = useTween(on, 1300)
  const play = usePlayhead(!!demo)
  // Allocated GPUs at the playhead, before and after policies.
  const at = useMemo(() => {
    if (!demo) return null
    const n = demo.a.sim.allocBefore.length
    const i = Math.min(n - 1, Math.floor(play * n))
    return { before: demo.a.sim.allocBefore[i], after: demo.a.sim.allocAfter[i] }
  }, [demo, play])

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="eyebrow">For ML platform and infra leads</div>
            <h1>Your cluster is full. <span className="accent">Your GPUs aren&rsquo;t.</span></h1>
            <p className="lede">GPU Fleet Report joins DCGM telemetry to Slurm or Kubernetes jobs and shows you, before anyone buys more, which GPUs are allocated but idle, which jobs could run on a MIG slice or fewer GPUs, what each team really costs, and the scheduler policies that win the capacity back.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=helix" className="btn primary lg">Try the sample cluster</Link>
              <Link href="/app" className="btn outline lg">Import your data</Link>
            </div>
            <p className="hero-note small">Runs in your browser. Nothing is uploaded unless you sign in to sync.</p>
          </div>
          <div className="hero-viz">
            <div className="viz-head">
              <div>
                <div className="viz-title">Helix research cluster <span className="badge synthetic">Synthetic</span></div>
                <div className="muted tiny">8 nodes × 8 H100 · 8 to 14 Oct 2026 · SM activity per GPU</div>
              </div>
              <div className="viz-counter" aria-live="polite">
                <strong><Counter value={on && demo ? demo.a.sim.freedGpus : 0} /></strong>
                <span>GPUs freed</span>
              </div>
            </div>
            {demo
              ? <Heatmap before={demo.before} after={demo.after} t={t} playhead={play} height={300} label="Live heatmap: 64 GPUs over one week, coloured by SM activity" />
              : <div className="viz-skeleton" role="status"><span className="spinner" /> Simulating a week of DCGM telemetry</div>}
            <div className="viz-foot">
              <button type="button" className={`btn ${on ? 'outline' : 'primary'} sm`} aria-pressed={on} onClick={() => setOn(!on)} disabled={!demo}>
                {on ? 'Undo policies' : 'Apply idle timeout + MIG plan'}
              </button>
              {at && <span className="small tab-nums">Allocated now: <strong>{on ? at.after : at.before}</strong>/64{on && at.before !== at.after && <span className="accent"> (was {at.before})</span>}</span>}
              <HeatLegend />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">The gap</div>
          <h2>&ldquo;We need more GPUs&rdquo; usually means &ldquo;our GPUs are booked&rdquo;</h2>
        </div>
        <div className="evidence">
          <article>
            <div className="big">{demo ? fmtPct(demo.a.allocShare) : '97%'}</div>
            <p><strong>allocated</strong> in the Helix sample, the number the scheduler sees.</p>
          </article>
          <article>
            <div className="big accent">{demo ? fmtPct(demo.a.meanSmAllocated) : '47%'}</div>
            <p><strong>SM active</strong> on those allocated GPUs, the number that matters.</p>
          </article>
          <article className="quote">
            <p>DCGM&rsquo;s GPU utilisation counts the time <em>any</em> kernel is running, so one tiny kernel reads as 100%. SM activity measures the share of streaming multiprocessors actually busy, which is why this report uses it.</p>
            <a href="https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/feature-overview.html#profiling-metrics" target="_blank" rel="noreferrer" className="small">NVIDIA DCGM user guide, profiling metrics</a>
          </article>
          <article className="quote">
            <p>Published studies of shared training clusters, from Microsoft&rsquo;s Philly analysis to Weights &amp; Biases&rsquo; look at its users&rsquo; runs, keep finding average utilisation well below what the allocation suggests; 30&ndash;50% is a common range, with a long tail of jobs far lower.</p>
            <span className="small"><a href="https://www.usenix.org/conference/atc19/presentation/jeon" target="_blank" rel="noreferrer">USENIX ATC &rsquo;19</a> · <a href="https://wandb.ai/wandb/common-ml-errors/reports/How-to-Monitor-and-Improve-GPU-Usage-for-Model-Training--VmlldzoxMjQ2MzM2" target="_blank" rel="noreferrer">W&amp;B</a></span>
          </article>
          <article className="quote">
            <p>On r/LocalLLM and r/MachineLearning the same question keeps coming back: how much VRAM does this model really need? The honest answer is weights plus a KV cache that grows with context and batch, which is why so many small services sit on 80 GB cards using a fraction of them.</p>
            <span className="small"><a href="https://www.reddit.com/r/LocalLLM/search/?q=how%20much%20vram" target="_blank" rel="noreferrer">r/LocalLLM</a> · <a href="https://www.reddit.com/r/MachineLearning/search/?q=kv%20cache%20memory" target="_blank" rel="noreferrer">r/MachineLearning</a> (threads read Nov 2026)</span>
          </article>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow">How it works</div>
          <h2>From exports to a policy you can merge, in one sitting</h2>
        </div>
        <ol className="steps">
          <li><span>01</span><h3>Import</h3><p>A Prometheus range query of DCGM metrics (or nvidia-smi logs), plus sacct or kubectl output. Formats are detected, columns mapped, bad rows listed by line. Big files parse in a worker.</p></li>
          <li><span>02</span><h3>Join and classify</h3><p>Every job is matched to its GPUs by host, index and time. Each gets mean and p95 SM and tensor activity, peak memory against capacity, idle hours, time at zero and a multi-GPU imbalance score.</p></li>
          <li><span>03</span><h3>Act</h3><p>Idle-timeout configs for Slurm and Kubernetes, a per-node MIG plan with the exact nvidia-smi commands, team statements, &ldquo;your jobs&rdquo; notes, and a CSV of everything.</p></li>
        </ol>
      </section>

      <section className="section">
        <div className="features">
          {[
            ['Five honest classes', 'Idle or abandoned notebook, under-utilised, memory-bound but compute-light, healthy, saturated. Thresholds are yours to tune.'],
            ['Right-sizing with MIG', 'Picks the smallest A100, H100, H200 or A30 MIG profile that fits peak memory plus headroom and p95 SM activity, or fewer GPUs for 8-GPU jobs that use 2.'],
            ['Chargeback that adds up', 'Per-account statements at your $/GPU-hour, on-prem amortised or cloud list, with idle spend called out. Printable.'],
            ['Recoverable capacity', 'A replay of the month with the policies on, re-packed per node, so "we could free 18 GPUs" is a number you can defend.'],
            ['Monthly history', 'Snapshot each month, note the policy you shipped, and compare utilisation before and after.'],
            ['Local first', 'Everything works signed out and stays on the device. Sign in only to sync settings and snapshots.'],
          ].map(([h, p]) => <article key={h} className="feature"><h3>{h}</h3><p>{p}</p></article>)}
        </div>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <h2>Find the GPUs you already own.</h2>
          <div className="row gap wrap">
            <Link href="/app?sample=atlas" className="btn primary lg">Open the inference sample</Link>
            <Link href="/docs" className="btn outline lg">Export commands</Link>
          </div>
        </div>
      </section>
    </>
  )
}
