// Parses large exports off the main thread.
import { mergeFleets, parseFile, type Format, type Mapping } from './engine/parse.ts'
import type { Fleet } from './engine/types.ts'

type Msg =
  | { id: number; type: 'parse'; text: string; fileName: string; format?: Format; map?: Mapping; hostDefault?: string; step: number; localTime?: boolean }
  | { id: number; type: 'merge'; a: Fleet | null; b: Fleet }

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data
  try {
    if (m.type === 'merge') { postMessage({ id: m.id, ok: true, result: mergeFleets(m.a, m.b) }); return }
    const r = parseFile(m.text, { fileName: m.fileName, format: m.format, map: m.map, hostDefault: m.hostDefault || undefined, step: m.step, localTime: m.localTime })
    postMessage({ id: m.id, ok: true, result: r })
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
