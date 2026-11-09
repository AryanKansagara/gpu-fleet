// MIG profiles per GPU, from the NVIDIA Multi-Instance GPU User Guide ("Supported MIG Profiles"), checked 2026-11-01.
// g = compute slices out of `slices`; mem = memory slices out of 8; gb = instance framebuffer as named by the profile.
import { gpuClass } from './parse.ts'

export interface MigProfile { name: string; g: number; mem: number; gb: number; max: number }
export interface MigGpu { label: string; slices: number; memSlices: number; profiles: MigProfile[] }

const p = (name: string, g: number, mem: number, gb: number, max: number): MigProfile => ({ name, g, mem, gb, max })

export const MIG_TABLE_DATE = '2026-11-01'

export const MIG_GPUS: Record<string, MigGpu> = {
  'A100-40GB': { label: 'A100 40GB', slices: 7, memSlices: 8, profiles: [p('1g.5gb', 1, 1, 5, 7), p('1g.10gb', 1, 2, 10, 4), p('2g.10gb', 2, 2, 10, 3), p('3g.20gb', 3, 4, 20, 2), p('4g.20gb', 4, 4, 20, 1), p('7g.40gb', 7, 8, 40, 1)] },
  'A100-80GB': { label: 'A100 80GB', slices: 7, memSlices: 8, profiles: [p('1g.10gb', 1, 1, 10, 7), p('1g.20gb', 1, 2, 20, 4), p('2g.20gb', 2, 2, 20, 3), p('3g.40gb', 3, 4, 40, 2), p('4g.40gb', 4, 4, 40, 1), p('7g.80gb', 7, 8, 80, 1)] },
  'H100-80GB': { label: 'H100 80GB', slices: 7, memSlices: 8, profiles: [p('1g.10gb', 1, 1, 10, 7), p('1g.20gb', 1, 2, 20, 4), p('2g.20gb', 2, 2, 20, 3), p('3g.40gb', 3, 4, 40, 2), p('4g.40gb', 4, 4, 40, 1), p('7g.80gb', 7, 8, 80, 1)] },
  'H100-94GB': { label: 'H100 NVL 94GB', slices: 7, memSlices: 8, profiles: [p('1g.12gb', 1, 1, 12, 7), p('1g.24gb', 1, 2, 24, 4), p('2g.24gb', 2, 2, 24, 3), p('3g.47gb', 3, 4, 47, 2), p('4g.47gb', 4, 4, 47, 1), p('7g.94gb', 7, 8, 94, 1)] },
  'H200-141GB': { label: 'H200 141GB', slices: 7, memSlices: 8, profiles: [p('1g.18gb', 1, 1, 18, 7), p('1g.35gb', 1, 2, 35, 4), p('2g.35gb', 2, 2, 35, 3), p('3g.71gb', 3, 4, 71, 2), p('4g.71gb', 4, 4, 71, 1), p('7g.141gb', 7, 8, 141, 1)] },
  'A30-24GB': { label: 'A30 24GB', slices: 4, memSlices: 4, profiles: [p('1g.6gb', 1, 1, 6, 4), p('2g.12gb', 2, 2, 12, 2), p('4g.24gb', 4, 4, 24, 1)] },
}

/** Picks the MIG table for a model name and framebuffer size; null when the GPU has no MIG. */
export function migGpu(model: string | undefined, memMiB?: number): MigGpu | null {
  const c = gpuClass(model)
  const gb = memMiB ? memMiB / 1024 : 0
  if (c === 'A100') return MIG_GPUS[gb && gb < 60 || /40GB/i.test(model ?? '') ? 'A100-40GB' : 'A100-80GB']
  if (c === 'H100') return MIG_GPUS[gb > 88 || /94GB|NVL/i.test(model ?? '') ? 'H100-94GB' : 'H100-80GB']
  if (c === 'H200') return MIG_GPUS['H200-141GB']
  if (c === 'A30') return MIG_GPUS['A30-24GB']
  return null
}

/** Smallest profile with enough memory (with headroom) and enough compute for the observed p95 SM activity. Null if only the full GPU fits. */
export function pickProfile(gpu: MigGpu, peakMiB: number, p95Sm: number, headroom: number): MigProfile | null {
  const needGb = (peakMiB * (1 + headroom)) / 1024
  const needG = p95Sm * gpu.slices
  const fit = gpu.profiles.filter(x => x.gb >= needGb && x.g >= needG && x.g < gpu.slices).sort((a, b) => a.g - b.g || a.gb - b.gb)
  return fit[0] ?? null
}

/** First-fit-decreasing packing of profiles into GPUs, respecting compute and memory slices. */
export function packProfiles(gpu: MigGpu, names: string[]): string[][] {
  const items = names.map(n => gpu.profiles.find(x => x.name === n)!).filter(Boolean).sort((a, b) => b.g - a.g || b.mem - a.mem)
  const bins: { g: number; mem: number; list: string[] }[] = []
  for (const it of items) {
    let bin = bins.find(b => b.g + it.g <= gpu.slices && b.mem + it.mem <= gpu.memSlices && b.list.filter(x => x === it.name).length < it.max)
    if (!bin) { bin = { g: 0, mem: 0, list: [] }; bins.push(bin) }
    bin.g += it.g; bin.mem += it.mem; bin.list.push(it.name)
  }
  return bins.map(b => b.list)
}

/** Shell commands to apply a per-GPU layout on one node. */
export function migCommands(host: string, layout: string[][]): string {
  const lines = [`# ${host}: ${layout.length} GPU${layout.length === 1 ? '' : 's'} partitioned. Drain the node first; enabling MIG resets the GPU.`]
  layout.forEach((list, i) => {
    lines.push(`sudo nvidia-smi -i ${i} -mig 1`)
    lines.push(`sudo nvidia-smi mig -i ${i} -cgi ${list.join(',')} -C`)
  })
  lines.push(`nvidia-smi mig -lgi   # verify instances`)
  return lines.join('\n')
}
