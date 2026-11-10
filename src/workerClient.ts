import type { Fleet } from './engine/types.ts'
import type { Format, Mapping, Parsed } from './engine/parse.ts'

export type ParseResult = Parsed & { headers: string[]; map: Mapping }

let w: Worker | null = null
let seq = 0
const waiting = new Map<number, { res(v: unknown): void; rej(e: Error): void }>()

function worker() {
  if (w) return w
  w = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    if (!p) return
    if (e.data.ok) p.res(e.data.result); else p.rej(new Error(e.data.error))
  }
  w.onerror = e => { for (const p of waiting.values()) p.rej(new Error(e.message || 'Parser crashed')); waiting.clear(); w = null }
  return w
}

const call = <T,>(msg: Record<string, unknown>) => new Promise<T>((res, rej) => {
  const id = ++seq
  waiting.set(id, { res: res as (v: unknown) => void, rej })
  worker().postMessage({ ...msg, id })
})

export const parseInWorker = (o: { text: string; fileName: string; format?: Format; map?: Mapping; hostDefault?: string; step: number }) => call<ParseResult>({ type: 'parse', ...o })
export const mergeInWorker = (a: Fleet | null, b: Fleet) => call<Fleet>({ type: 'merge', a, b })
