# GPU Fleet Report

Shows ML platform teams how their GPUs are actually used: allocated-but-idle GPUs, memory headroom, jobs that should run on a MIG slice or fewer GPUs, per-team chargeback, and the scheduler policies that recover capacity. Built for the infra lead who keeps hearing "we need more GPUs".

**Live:** https://gpu-fleet.vercel.app

## The pain

Schedulers report a cluster as full when every GPU is allocated, not when every GPU is busy. Forgotten Jupyter sessions hold H100s for days, 8-GPU fine-tunes use 2, and small inference models sit on whole 80 GB cards. GPU utilisation hides this because one small kernel reads as 100%; DCGM's SM activity does not.

## Features

- **Import** DCGM metrics from a Prometheus range query (JSON or CSV, long or wide), `nvidia-smi --query-gpu` logs, Slurm `sacct -P`, `kubectl get pods -o json` or custom-columns, or any jobs CSV. Format detection, column mapping and a validation report with line numbers. Large files parse in a Web Worker.
- **Join** jobs to GPUs by host, GPU index and time (known indices, then dcgm-exporter `hpc_job`/pod labels, then lowest free GPUs, flagged).
- **Per job**: GPU-hours, mean/p95 SM and tensor activity, framebuffer peak vs capacity, idle GPU-hours, time at zero, multi-GPU imbalance. Classified as idle/abandoned, under-utilised, memory-bound compute-light, healthy or saturated.
- **Right-sizing**: fewer GPUs, the smallest MIG profile that fits (dated A100/A30/H100/H200 table), or a smaller GPU class.
- **Recoverable capacity**: the month replayed with an idle timeout, MIG slices and right-sized GPU counts, re-packed per node. The fleet heatmap animates before and after.
- **Actions**: Slurm `slurm.conf`, `job_submit.lua` and an idle reaper; JupyterHub and Kubeflow cullers; a PrometheusRule; a per-node MIG plan with `nvidia-smi mig` commands and a mig-parted config. Per-team printable statements, per-user "your jobs" reports, CSV exports.
- **Chargeback** at editable $/GPU-hour with an on-prem amortisation calculator.
- **History**: monthly snapshots, a trend with a projected "with policies" point, and a compare view by account.
- Local-first (IndexedDB). Optional email sign-in syncs clusters, settings and snapshots.
- Two synthetic sample clusters: a 64× H100 Slurm research cluster and a 40-GPU Kubernetes inference fleet.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # engine tests
npm run build
```

Cloud sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (see `.env.example`). Without them the app runs in local-only mode.

Built by Aryan Kansagara. Independent project, not affiliated with NVIDIA.
