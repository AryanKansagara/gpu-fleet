import { MIG_GPUS, MIG_TABLE_DATE } from './engine/mig.ts'
import { DEFAULT_CONFIG } from './engine/types.ts'
import { Code, Link } from './ui.tsx'

const PROM_QUERIES = `# Run each against /api/v1/query_range for the month, step=60s (or 300s for big fleets).
# Keep the raw metric names: the importer reads __name__ to know what each series is.
DCGM_FI_PROF_SM_ACTIVE
DCGM_FI_PROF_PIPE_TENSOR_ACTIVE
DCGM_FI_PROF_DRAM_ACTIVE
DCGM_FI_DEV_FB_USED
DCGM_FI_DEV_FB_FREE
DCGM_FI_DEV_GPU_UTIL
DCGM_FI_DEV_POWER_USAGE`

const PROM_CURL = `PROM=http://prometheus.monitoring:9090
START=2026-10-01T00:00:00Z END=2026-11-01T00:00:00Z STEP=60s
for m in DCGM_FI_PROF_SM_ACTIVE DCGM_FI_PROF_PIPE_TENSOR_ACTIVE DCGM_FI_DEV_FB_USED DCGM_FI_DEV_FB_FREE DCGM_FI_DEV_POWER_USAGE; do
  curl -fsG "$PROM/api/v1/query_range" \\
    --data-urlencode "query=$m" \\
    --data-urlencode "start=$START" --data-urlencode "end=$END" --data-urlencode "step=$STEP" \\
    > "dcgm-$m.json"
done
# Prometheus caps a query at 11,000 points per series: at 60s steps that is ~7.5 days.
# For a whole month use STEP=300s, or run the loop once per week and import every file.`

const SACCT = `TZ=UTC sacct --allusers --allocations --parsable2 \\
  --starttime=2026-10-01T00:00:00 --endtime=2026-11-01T00:00:00 \\
  --format=JobID,JobName%60,User,Account,Partition,State,Start,End,Elapsed,NNodes,NodeList,AllocTRES \\
  > sacct-2026-10.txt`

const SCONTROL = `# Optional: exact GPU indices for running jobs (sacct does not record them).
scontrol show job -d | awk '/JobId=/{split($1,a,"=");id=a[2]} /Nodes=.*GRES=.*IDX/{match($0,/IDX:[0-9,-]+/);print id","substr($0,RSTART+4,RLENGTH-4)}'
# Better for history: run dcgm-exporter with --hpc-job-mapping-dir so every metric carries an hpc_job label.`

const KUBECTL_JSON = `kubectl get pods -A -o json > pods.json`
const KUBECTL_COLS = `kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,POD:.metadata.name,NODE:.spec.nodeName,GPUS:.spec.containers[*].resources.limits.nvidia\\.com/gpu,START:.status.startTime,TEAM:.metadata.labels.team' > pods.txt`

const SMI = `# On each node, log every 60 s. The file name becomes the host name (nvidia-smi-<host>.csv).
nvidia-smi --query-gpu=timestamp,index,uuid,name,utilization.gpu,memory.used,memory.total,power.draw \\
  --format=csv,nounits -l 60 > "nvidia-smi-$(hostname -s).csv"`

const JOBS_CSV = `job_id,name,user,account,start,end,gpus,nodelist,gpu_idx
88121,ft-llama,dmitri.k,nlp-finetune,2026-10-03T08:00:00Z,2026-10-04T02:00:00Z,8,gpu07,0-7
88140,jupyter,lena.m,vision,2026-10-03T09:12:00Z,2026-10-06T09:12:00Z,1,gpu02,3`

export default function Docs() {
  return (
    <section className="page docs">
      <aside className="toc" aria-label="On this page">
        <div className="eyebrow">Docs</div>
        <nav>
          <a href="#overview">What you need</a>
          <a href="#dcgm">DCGM via Prometheus</a>
          <a href="#smi">nvidia-smi logs</a>
          <a href="#slurm">Slurm sacct</a>
          <a href="#k8s">Kubernetes pods</a>
          <a href="#csv">Any jobs CSV</a>
          <a href="#sm-vs-util">SM activity vs utilisation</a>
          <a href="#method">How the numbers work</a>
          <a href="#mig">MIG profile table</a>
          <a href="#rates">Rates</a>
          <a href="#privacy">Privacy and sync</a>
        </nav>
      </aside>
      <div className="docs-body">
        <h1>Getting your data out</h1>
        <p className="muted">Commands checked against DCGM 3.3/4.x, dcgm-exporter 3.3+, Slurm 23.11 to 24.11 and Kubernetes 1.29+, November 2026.</p>

        <h2 id="overview">What you need</h2>
        <p>Two things: <strong>GPU metrics</strong> over time, and <strong>who held which GPU when</strong>. If dcgm-exporter attaches pod or hpc_job labels (it does on Kubernetes with the GPU Operator), the metrics alone are enough. Import as many files as you like; GPUs merge by host and index, jobs by ID.</p>

        <h2 id="dcgm">DCGM metrics via Prometheus (recommended)</h2>
        <p>dcgm-exporter publishes profiling metrics only if they are in its counters CSV. Make sure <code>DCGM_FI_PROF_SM_ACTIVE</code>, <code>DCGM_FI_PROF_PIPE_TENSOR_ACTIVE</code> and <code>DCGM_FI_PROF_DRAM_ACTIVE</code> are enabled (they are in the default <code>dcp-metrics-included.csv</code>).</p>
        <Code label="PromQL series" code={PROM_QUERIES} />
        <Code label="Export the month" code={PROM_CURL} />
        <p>Expected labels: <code>gpu</code>, <code>UUID</code>, <code>Hostname</code> (or <code>instance</code>), <code>modelName</code>, and when present <code>hpc_job</code>, <code>pod</code>/<code>namespace</code> or <code>exported_pod</code>/<code>exported_namespace</code>. Grafana CSV exports work too: long format (time, metric, value, labels) or wide (one column per DCGM field).</p>

        <h2 id="smi">nvidia-smi logs (no Prometheus)</h2>
        <Code label="On every node" code={SMI} />
        <p>nvidia-smi has no SM activity counter, so the report falls back to <code>utilization.gpu</code> and marks those numbers as an upper bound.</p>

        <h2 id="slurm">Slurm: sacct</h2>
        <Code label="One month of GPU allocations" code={SACCT} />
        <p><code>--allocations</code> drops job steps, <code>--parsable2</code> gives pipe-separated output with a header, and <code>TZ=UTC</code> keeps times in UTC to line up with Prometheus. GPUs come from <code>AllocTRES</code> (<code>gres/gpu=8</code>); multi-node jobs split them evenly across <code>NodeList</code>.</p>
        <Code label="GPU indices" code={SCONTROL} />
        <p>Without indices or labels, a job is placed on the lowest free GPUs of its node, the way <code>select/cons_tres</code> usually allocates. Those jobs are flagged as inferred.</p>

        <h2 id="k8s">Kubernetes: pods</h2>
        <Code label="Full JSON (preferred)" code={KUBECTL_JSON} />
        <Code label="Or a compact pod map" code={KUBECTL_COLS} />
        <p>Pods requesting <code>nvidia.com/gpu</code> become jobs. The account is the <code>team</code> label, else the namespace; the user is the <code>user</code> label. Completed pods vanish from the API, so for history rely on dcgm-exporter&rsquo;s pod labels.</p>

        <h2 id="csv">Any jobs CSV</h2>
        <Code label="Columns" code={JOBS_CSV} />
        <p>Times are ISO 8601 (UTC unless an offset is given) or epoch seconds. <code>gpus</code> can be a count or an AllocTRES string. Every rejected row is listed with its line number before import.</p>

        <h2 id="sm-vs-util">SM activity, not GPU utilisation</h2>
        <p>Per NVIDIA&rsquo;s DCGM documentation, <code>DCGM_FI_DEV_GPU_UTIL</code> is the fraction of time at least one kernel was running. A single small kernel keeps it at 100% while almost every SM sits idle. <code>DCGM_FI_PROF_SM_ACTIVE</code> is the fraction of time at least one warp was resident on an SM, averaged over all SMs, so it tracks how much of the chip is in use. <code>DCGM_FI_PROF_PIPE_TENSOR_ACTIVE</code> shows whether the tensor cores you paid for are doing the work. <a href="https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/feature-overview.html#profiling-metrics" target="_blank" rel="noreferrer">DCGM user guide: profiling metrics</a>.</p>

        <h2 id="method">How the numbers work</h2>
        <ul>
          <li><strong>Buckets.</strong> Samples are averaged into 1 to 60 minute buckets; framebuffer keeps the bucket peak.</li>
          <li><strong>Idle.</strong> A GPU-bucket is idle when SM active is under {DEFAULT_CONFIG.idleThreshold * 100}% (tunable). Idle GPU-hours scale the idle share of observed buckets to the whole allocation.</li>
          <li><strong>Classes.</strong> Idle/abandoned: mean SM under the threshold and either more than half the time at zero or idle for the timeout in a row. Saturated: mean SM {DEFAULT_CONFIG.saturatedThreshold * 100}%+. Memory-bound, compute-light: p95 SM under {DEFAULT_CONFIG.lightThreshold * 100}% on 1 to 2 balanced GPUs. Under-utilised: mean SM under {DEFAULT_CONFIG.healthyThreshold * 100}% or imbalance 0.5+. Otherwise healthy.</li>
          <li><strong>Imbalance.</strong> 1 − mean(per-GPU SM) ÷ max(per-GPU SM). An 8-GPU job where 2 GPUs work scores about 0.75.</li>
          <li><strong>Recoverable capacity.</strong> The window is replayed with the policies on: idle jobs end after the timeout, unused GPUs are dropped, MIG candidates take a slice. Each node is re-packed per bucket onto the lowest GPU indices; work never moves between nodes. The difference in GPUs allocated, averaged over time, is the recoverable GPU-equivalents.</li>
          <li><strong>MIG plan.</strong> For each node, the busiest moment of compute-light demand is packed first-fit-decreasing into GPUs, respecting compute and memory slices. Confirm placements with <code>nvidia-smi mig -lgip</code> before applying.</li>
        </ul>

        <h2 id="mig">MIG profiles (NVIDIA MIG User Guide, checked {MIG_TABLE_DATE})</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>GPU</th><th>Profiles (max instances)</th></tr></thead>
            <tbody>{Object.values(MIG_GPUS).map(g => <tr key={g.label}><th scope="row">{g.label}</th><td className="small">{g.profiles.map(p => `${p.name} (${p.max})`).join(', ')}</td></tr>)}</tbody>
          </table>
        </div>

        <h2 id="rates">Rates</h2>
        <p>Default $/GPU-hour values are illustrative placeholders as of November 2026 (H100 {DEFAULT_CONFIG.rates.H100}, A100 {DEFAULT_CONFIG.rates.A100}, L4 {DEFAULT_CONFIG.rates.L4}), not quotes. Replace them with your contract rate, or with an amortised on-prem rate: (capex per GPU + yearly opex × years) ÷ (years × 8,760). The Chargeback tab has a calculator.</p>

        <h2 id="privacy">Privacy and sync</h2>
        <p>Files are parsed in a Web Worker in your browser and stored in IndexedDB. Signing in (optional) syncs cluster settings, rates, the import log and monthly snapshots. Raw telemetry syncs only when it is under 1.5 MB; otherwise it stays on the device where you imported it.</p>
        <p><Link href="/app" className="btn primary">Open the app</Link></p>
      </div>
    </section>
  )
}
