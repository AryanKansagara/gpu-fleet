import { useEffect, useRef, useState } from 'react'

/** Animated number that eases to its target. */
export function Counter({ value, digits = 1 }: { value: number; digits?: number }) {
  const [v, setV] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = performance.now(), a = from.current, reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setV(value); from.current = value; return }
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 900)
      const e = 1 - Math.pow(1 - k, 3)
      setV(a + (value - a) * e)
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); from.current = value }
  }, [value])
  return <>{v.toFixed(digits)}</>
}

/** 0 -> 1 tween when `on` flips. */
export function useTween(on: boolean, ms = 1100) {
  const [t, setT] = useState(on ? 1 : 0)
  const cur = useRef(t)
  useEffect(() => {
    const target = on ? 1 : 0
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cur.current = target; setT(target); return }
    const a = cur.current, start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / ms)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      cur.current = a + (target - a) * e
      setT(cur.current)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [on])
  return t
}

