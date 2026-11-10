import { useEffect, useRef, useState } from 'react'
import type { Heat } from './engine/analyze.ts'
import { useDark } from './ui.tsx'

type RGB = [number, number, number]
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function palette(dark: boolean) {
  return dark
    ? { free: hex('#161616'), idle: hex('#5a1d1d'), lo: hex('#24380a'), hi: hex('#76b900'), top: hex('#c6f36a'), gap: '#000000' }
    : { free: hex('#ececec'), idle: hex('#f2b8b5'), lo: hex('#d9ebb8'), hi: hex('#76b900'), top: hex('#3f6b00'), gap: '#ffffff' }
}

function cellColor(p: ReturnType<typeof palette>, alloc: number, load: number, idleThr: number): RGB {
  if (alloc < 0.5) return load > idleThr ? mix(p.free, p.lo, 0.6) : p.free
  if (load < idleThr) return p.idle
  const l = Math.min(1, load)
  return l < 0.7 ? mix(p.lo, p.hi, l / 0.7) : mix(p.hi, p.top, (l - 0.7) / 0.3)
}

/**
 * Nodes × GPUs (rows) over time (columns), coloured by SM activity. Allocated-but-idle cells are red.
 * `t` blends from `before` (0) to `after` (1) so policy changes animate in place.
 */
export function Heatmap({ before, after, t = 0, idleThr = 0.05, playhead, height, label }: { before: Heat; after?: Heat; t?: number; idleThr?: number; playhead?: number; height?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const dark = useDark()
  const [w, setW] = useState(800)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const rows = before.rows.length
  const hostBreaks = before.rows.map((r, i) => i > 0 && before.rows[i - 1].host !== r.host)
  const nBreaks = hostBreaks.filter(Boolean).length
  const cellH = height ? Math.max(2, (height - nBreaks * 3) / rows) : Math.max(3, Math.min(9, 520 / rows))
  const H = Math.round(rows * cellH + nBreaks * 3)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, devicePixelRatio || 1)
    c.width = Math.round(w * dpr); c.height = Math.round(H * dpr)
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const p = palette(dark)
    ctx.fillStyle = p.gap
    ctx.fillRect(0, 0, w, H)
    const cols = before.cols
    const cw = w / cols
    let y = 0
    for (let r = 0; r < rows; r++) {
      if (hostBreaks[r]) y += 3
      for (let k = 0; k < cols; k++) {
        const i = r * cols + k
        let col = cellColor(p, before.alloc[i], before.load[i], idleThr)
        if (after && t > 0) col = mix(col, cellColor(p, after.alloc[i], after.load[i], idleThr), t)
        ctx.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`
        ctx.fillRect(k * cw, y, Math.max(1, cw - (cw > 4 ? 1 : 0)), Math.max(1, cellH - (cellH > 4 ? 1 : 0)))
      }
      y += cellH
    }
    if (playhead !== undefined) {
      const x = playhead * w
      const g = ctx.createLinearGradient(x - 60, 0, x, 0)
      g.addColorStop(0, 'rgba(118,185,0,0)'); g.addColorStop(1, dark ? 'rgba(118,185,0,0.28)' : 'rgba(118,185,0,0.22)')
      ctx.fillStyle = g
      ctx.fillRect(x - 60, 0, 60, H)
      ctx.fillStyle = '#76b900'
      ctx.fillRect(x - 1, 0, 2, H)
    }
  }, [before, after, t, w, H, dark, playhead, idleThr])

  const onMove = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    const x = e.clientX - rect.left, yy = e.clientY - rect.top
    const k = Math.floor(x / (rect.width / before.cols))
    let y = 0, r = -1
    for (let i = 0; i < rows; i++) { if (hostBreaks[i]) y += 3; if (yy >= y && yy < y + cellH) { r = i; break } y += cellH }
    if (r < 0 || k < 0 || k >= before.cols) { setTip(null); return }
    const src = after && t > 0.5 ? after : before
    const i = r * before.cols + k
    const when = new Date(before.t0 + k * before.colMs)
    const state = src.alloc[i] < 0.5 ? 'free' : src.load[i] < idleThr ? 'allocated, idle' : 'allocated'
    setTip({ x, y: yy, text: `${before.rows[r].host} · GPU ${before.rows[r].gpu}\n${when.toISOString().slice(5, 16).replace('T', ' ')} UTC\nSM active ${(src.load[i] * 100).toFixed(0)}% · ${state}` })
  }

  return (
    <div className="heatwrap" ref={wrap}>
      <canvas ref={ref} style={{ width: '100%', height: H }} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      {tip && <div className="heat-tip" style={{ left: Math.min(tip.x + 12, w - 190), top: tip.y + 12 }}>{tip.text}</div>}
    </div>
  )
}

export function HeatLegend() {
  return (
    <div className="heat-legend small" aria-hidden="true">
      <span><i className="sw free" />Free</span>
      <span><i className="sw idle" />Allocated, idle</span>
      <span><i className="sw ramp" />SM active 5% → 100%</span>
    </div>
  )
}
