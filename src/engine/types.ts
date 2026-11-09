/** One physical GPU's telemetry, bucketed to the fleet step. NaN means no sample in that bucket. */
export interface GpuTrack {
  key: string
  host: string
  gpu: number
  uuid?: string
  model?: string
  /** Framebuffer capacity in MiB, when known. */
  memMiB?: number
  /** SM active, 0..1 (DCGM_FI_PROF_SM_ACTIVE, or GPU_UTIL as a proxy when smProxy is set). */
  sm: number[]
  tensor: number[]
  /** Framebuffer used, MiB (peak within the bucket). */
  fb: number[]
  power: number[]
  /** True when SM activity came from GPU utilisation, which overstates real work. */
  smProxy?: boolean
  /** Job or pod label seen on the metric in that bucket (dcgm-exporter pod/hpc_job labels). */
  owner: (string | null)[]
}

export interface Fleet {
  /** Start of bucket 0, ms since epoch. */
  t0: number
  /** Bucket width, seconds. */
  step: number
  n: number
  tracks: GpuTrack[]
}

export interface Job {
  id: string
  name?: string
  user: string
  account: string
  partition?: string
  state?: string
  start: number
  end: number
  /** Total GPUs allocated across all hosts. */
  gpus: number
  hosts: string[]
  /** Known GPU indices per host (from scontrol IDX, a gpu_idx column, or metric labels). */
  gpuIdx?: Record<string, number[]>
  model?: string
  source: 'slurm' | 'k8s' | 'labels' | 'csv'
}

export type JobClass = 'idle' | 'under' | 'membound' | 'healthy' | 'saturated' | 'nodata'

export interface Config {
  /** SM active below this counts as idle. */
  idleThreshold: number
  /** p95 SM active below this is compute-light. */
  lightThreshold: number
  /** Mean SM active at or above this is healthy. */
  healthyThreshold: number
  /** Mean SM active at or above this is saturated. */
  saturatedThreshold: number
  /** Idle for this many hours in a row before a job counts as abandoned, and the timeout the policy uses. */
  idleTimeoutHours: number
  /** Extra framebuffer kept free when picking a MIG profile or smaller GPU. */
  memHeadroom: number
  /** $/GPU-hour by GPU class (H100, A100, ...). */
  rates: Record<string, number>
  defaultRate: number
  currency: string
  /** Which recommendations the simulator applies. */
  applied: { idleTimeout: boolean; mig: boolean; fewer: boolean }
}

export const DEFAULT_CONFIG: Config = {
  idleThreshold: 0.05,
  lightThreshold: 0.35,
  healthyThreshold: 0.4,
  saturatedThreshold: 0.8,
  idleTimeoutHours: 2,
  memHeadroom: 0.15,
  rates: { H100: 2.5, H200: 3.2, A100: 1.6, L40S: 1.1, L4: 0.6, A10: 0.6, T4: 0.35, V100: 0.8 },
  defaultRate: 1.5,
  currency: 'USD',
  applied: { idleTimeout: true, mig: true, fewer: true },
}

export interface Issue { line: number; level: 'error' | 'warn'; message: string }
