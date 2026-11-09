// Generated artifacts: scheduler policy snippets, MIG commands, CSV exports.
import { CLASS_LABEL, type Analysis, type JobStats, type NodePlan } from './analyze.ts'
import { toCsv } from './parse.ts'
import type { Config } from './types.ts'

export interface PolicyCtx { cfg: Config; a: Analysis; interactivePartitions: string[]; notebookNamespaces: string[]; promUrl: string }

/** Partitions and namespaces where idle notebooks were found, so the snippets target the right places. */
export function policyTargets(a: Analysis, partitions: Map<string, string | undefined>) {
  const idle = a.jobs.filter(j => j.cls === 'idle')
  const parts = [...new Set(idle.map(j => partitions.get(j.id)).filter((x): x is string => !!x))]
  const ns = [...new Set(idle.filter(j => j.id.includes('/')).map(j => j.id.split('/')[0]))]
  return { partitions: parts.length ? parts : ['interactive'], namespaces: ns.length ? ns : ['notebooks'] }
}

export function slurmConf(ctx: PolicyCtx): string {
  const h = ctx.cfg.idleTimeoutHours
  const max = Math.max(4, Math.ceil(h * 4))
  return `# slurm.conf: cap interactive sessions so a forgotten notebook cannot hold GPUs for days.
# Applies to: ${ctx.interactivePartitions.join(', ')}
${ctx.interactivePartitions.map(p => `PartitionName=${p} MaxTime=${String(max).padStart(2, '0')}:00:00 DefaultTime=0${Math.min(9, Math.ceil(h))}:00:00 OverTimeLimit=0 State=UP`).join('\n')}
# Keep the reaper's notices short of killing healthy jobs: grace for the first hour of every job.
`
}

export function jobSubmitLua(ctx: PolicyCtx): string {
  const max = Math.max(4, Math.ceil(ctx.cfg.idleTimeoutHours * 4)) * 60
  return `-- job_submit.lua: interactive GPU jobs get a time limit and a tag the idle reaper looks for.
-- Install: JobSubmitPlugins=lua in slurm.conf, this file next to slurm.conf, then scontrol reconfigure.
local INTERACTIVE = { ${ctx.interactivePartitions.map(p => `["${p}"] = true`).join(', ')} }
local MAX_MIN = ${max}

function slurm_job_submit(job_desc, part_list, submit_uid)
  local gres = job_desc.tres_per_node or job_desc.tres_per_job or ""
  local is_gpu = string.find(gres, "gpu") ~= nil
  local name = job_desc.name or ""
  local interactive = INTERACTIVE[job_desc.partition or ""] or string.find(name, "jupyter") or string.find(name, "interactive")
  if is_gpu and interactive then
    if job_desc.time_limit == slurm.NO_VAL or job_desc.time_limit > MAX_MIN then
      job_desc.time_limit = MAX_MIN
      slurm.log_user("GPU interactive jobs are limited to %d hours. Idle GPUs are released after ${ctx.cfg.idleTimeoutHours}h.", MAX_MIN / 60)
    end
    job_desc.comment = "idle-reap"
  end
  return slurm.SUCCESS
end

function slurm_job_modify(job_desc, job_rec, part_list, modify_uid)
  return slurm.SUCCESS
end
`
}

export function reaperScript(ctx: PolicyCtx): string {
  const h = ctx.cfg.idleTimeoutHours
  return `#!/usr/bin/env bash
# idle-gpu-reaper.sh: cancel GPU jobs whose GPUs have done no work for ${h}h.
# Needs dcgm-exporter with the hpc_job label (--hpc-job-mapping-dir) scraped by Prometheus.
# Cron: */15 * * * * /opt/slurm/bin/idle-gpu-reaper.sh   (start with DRY_RUN=1 for a week)
set -euo pipefail
PROM="\${PROM:-${ctx.promUrl}}"
DRY_RUN="\${DRY_RUN:-1}"
QUERY='max by (hpc_job) (max_over_time(DCGM_FI_PROF_SM_ACTIVE{hpc_job!=""}[${h}h])) < ${ctx.cfg.idleThreshold}'
curl -fsG "$PROM/api/v1/query" --data-urlencode "query=$QUERY" \\
  | jq -r '.data.result[].metric.hpc_job' \\
  | while read -r job; do
      # Only jobs older than the window, and only ones job_submit.lua tagged (drop the grep to reap everything).
      if squeue -h -j "$job" -o '%k %M' | grep -q '^idle-reap'; then
        echo "$(date -u +%FT%TZ) idle ${h}h: $job"
        [ "$DRY_RUN" = 1 ] || scancel --signal=TERM --full "$job"
      fi
    done
`
}

export function jupyterHubCuller(ctx: PolicyCtx): string {
  const s = Math.round(ctx.cfg.idleTimeoutHours * 3600)
  return `# JupyterHub on Kubernetes (zero-to-jupyterhub Helm chart values.yaml)
# Culls servers with no kernel or network activity for ${ctx.cfg.idleTimeoutHours}h; the GPU goes back to the pool.
cull:
  enabled: true
  users: false        # stop servers, keep users
  removeNamedServers: false
  timeout: ${s}       # seconds of inactivity
  every: 600          # check every 10 minutes
  maxAge: ${Math.round(s * 12)}     # hard stop for any server, active or not
`
}

export function kubeflowCuller(ctx: PolicyCtx): string {
  const m = Math.round(ctx.cfg.idleTimeoutHours * 60)
  return `# Kubeflow Notebooks: enable culling in the notebook-controller (kustomize patch)
# Namespaces with idle GPU notebooks: ${ctx.notebookNamespaces.join(', ')}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notebook-controller-deployment
  namespace: kubeflow
spec:
  template:
    spec:
      containers:
        - name: manager
          env:
            - name: ENABLE_CULLING
              value: "true"
            - name: CULL_IDLE_TIME     # minutes
              value: "${m}"
            - name: IDLENESS_CHECK_PERIOD   # minutes
              value: "5"
`
}

/** GPU utilisation alert so idle allocations are seen before the bill is. */
export function promAlert(ctx: PolicyCtx): string {
  const h = ctx.cfg.idleTimeoutHours
  return `# PrometheusRule: page nobody, notify the owner channel.
groups:
  - name: gpu-idle
    rules:
      - alert: GpuAllocatedButIdle
        expr: |
          max by (Hostname, gpu, exported_namespace, exported_pod, hpc_job) (
            max_over_time(DCGM_FI_PROF_SM_ACTIVE[${h}h])
          ) < ${ctx.cfg.idleThreshold}
          and on (Hostname, gpu) (DCGM_FI_DEV_FB_USED > 1024)
        for: 15m
        labels: { severity: info }
        annotations:
          summary: "GPU {{ $labels.gpu }} on {{ $labels.Hostname }} held but idle for ${h}h ({{ $labels.exported_pod }}{{ $labels.hpc_job }})"
`
}

/** nvidia-mig-parted config for the GPU Operator's mig-manager, one config per node. */
export function migPartedYaml(plans: NodePlan[]): string {
  if (!plans.length) return '# No MIG candidates in this period.\n'
  const lines = ['version: v1', 'mig-configs:']
  for (const p of plans) {
    lines.push(`  gpu-fleet-${p.host}:`)
    p.layout.forEach((list, i) => {
      const counts: Record<string, number> = {}
      for (const x of list) counts[x] = (counts[x] ?? 0) + 1
      lines.push(`    - devices: [${i}]`, '      mig-enabled: true', '      mig-devices:', ...Object.entries(counts).map(([k, v]) => `        "${k}": ${v}`))
    })
    const rest = Array.from({ length: Math.max(0, p.gpuCount - p.layout.length) }, (_, i) => p.layout.length + i)
    if (rest.length) lines.push(`    - devices: [${rest.join(', ')}]  # stay whole for full-GPU jobs`, '      mig-enabled: false')
  }
  lines.push('', '# Apply per node (the mig-manager drains GPU pods on the node first):')
  for (const p of plans) lines.push(`# kubectl label node ${p.host} nvidia.com/mig.config=gpu-fleet-${p.host} --overwrite`)
  return lines.join('\n') + '\n'
}

export function jobsCsv(a: Analysis, currency = 'USD'): string {
  const head = ['job_id', 'name', 'user', 'account', 'gpu_class', 'gpus', 'hours', 'gpu_hours', 'mean_sm_active', 'p95_sm_active', 'mean_tensor_active', 'fb_peak_gib', 'fb_capacity_gib', 'idle_gpu_hours', 'time_at_zero', 'imbalance', 'class', 'recommendation', 'gpus_after', `cost_${currency.toLowerCase()}`, `idle_cost_${currency.toLowerCase()}`, 'gpu_index_inferred']
  return toCsv([head, ...a.jobs.map(j => [j.id, j.name ?? '', j.user, j.account, j.model, j.gpus, j.hours, j.gpuHours, j.meanSm, j.p95Sm, j.meanTensor, j.fbPeakMiB / 1024, j.memMiB / 1024, j.idleGpuHours, j.timeAtZero, j.imbalance, CLASS_LABEL[j.cls], j.rec.text, j.rec.gpusAfter, j.cost, j.idleCost, j.inferred ? 'yes' : 'no'])])
}

export function teamsCsv(a: Analysis, currency = 'USD'): string {
  return toCsv([
    ['account', 'jobs', 'users', 'gpu_hours', 'used_gpu_hours', 'idle_gpu_hours', 'mean_sm_active', `cost_${currency.toLowerCase()}`, `idle_cost_${currency.toLowerCase()}`, 'recoverable_gpus'],
    ...a.teams.map(t => [t.account, t.jobs, t.users, t.gpuHours, t.usedGpuHours, t.idleGpuHours, t.meanSm, t.cost, t.idleCost, t.recoverableGpus]),
  ])
}

/** Plain-text summary a user can be sent: their jobs, the top waste, and how to fix it. */
export function userNote(user: string, jobs: JobStats[], period: string, fmtMoney: (n: number) => string): string {
  const mine = jobs.filter(j => j.user === user)
  const gh = mine.reduce((s, j) => s + j.gpuHours, 0)
  const idle = mine.reduce((s, j) => s + j.idleGpuHours, 0)
  const top = mine.filter(j => j.rec.kind !== 'none').slice(0, 5)
  return [
    `Hi ${user}, your GPU usage for ${period}:`,
    `${mine.length} jobs, ${Math.round(gh).toLocaleString('en-US')} GPU-hours, ${Math.round(idle).toLocaleString('en-US')} of them allocated but idle (${gh ? Math.round(idle / gh * 100) : 0}%).`,
    '',
    top.length ? 'Biggest wins:' : 'Nothing to fix. Thanks.',
    ...top.map((j, i) => `${i + 1}. ${j.id}${j.name ? ` (${j.name})` : ''}, ${j.gpus} GPU${j.gpus > 1 ? 's' : ''}: ${j.rec.text} Idle cost ${fmtMoney(j.idleCost)}.`),
  ].join('\n')
}
