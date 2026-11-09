import { FIELDS } from './engine/csv.ts'
import { Code, Link } from './ui.tsx'

const PD_API = `# Incidents for one quarter (paginate with offset until "more" is false)
curl -s -H "Authorization: Token token=$PD_TOKEN" \\
  -H "Accept: application/vnd.pagerduty+json;version=2" \\
  "https://api.pagerduty.com/incidents?since=2026-07-01T00:00:00Z&until=2026-10-01T00:00:00Z&statuses[]=resolved&time_zone=UTC&limit=100&offset=0" \\
  > incidents-0.json

# Optional: who was notified, who acked, and whether an integration resolved it
curl -s -H "Authorization: Token token=$PD_TOKEN" \\
  -H "Accept: application/vnd.pagerduty+json;version=2" \\
  "https://api.pagerduty.com/log_entries?since=2026-07-01T00:00:00Z&until=2026-10-01T00:00:00Z&is_overview=false&limit=100&offset=0" \\
  > log_entries-0.json`

const ROOTLY_API = `curl -s -H "Authorization: Bearer $ROOTLY_TOKEN" \\
  "https://api.rootly.com/v1/incidents?filter[started_at][gte]=2026-07-01&filter[started_at][lt]=2026-10-01&page[size]=100&page[number]=1" \\
  > rootly-incidents-1.json

# Alerts (pages) rather than declared incidents:
curl -s -H "Authorization: Bearer $ROOTLY_TOKEN" \\
  "https://api.rootly.com/v1/alerts?page[size]=100&page[number]=1" > rootly-alerts-1.json`

const GENERIC = `id,created_at,title,service,person,urgency,acknowledged_at,resolved_at,auto_resolved,actionable,dedup_key
A-1001,2026-09-14T02:13:00Z,Disk usage above 90% on db-3,payments-db,Priya Raman,high,2026-09-14T02:19:00Z,2026-09-14T02:31:00Z,false,,disk-db-3
A-1002,2026-09-14T02:40:00-04:00,Disk usage above 90% on db-3,payments-db,Priya Raman,high,,2026-09-14T02:43:00-04:00,true,,disk-db-3`

export default function Docs() {
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting your on-call history out</h1>
      <p className="muted">Export one quarter (or more) of pages from your paging tool, then drop the file on a team&rsquo;s <strong>Data &amp; people</strong> tab. Formats are detected from the header; every column can be re-mapped by hand, and the validation report lists every rejected row by line number. Last reviewed November 2026: vendor menus move, so if a label differs, look for the nearest equivalent.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#pagerduty">PagerDuty CSV</a><a href="#pagerduty-api">PagerDuty API</a><a href="#opsgenie">Opsgenie</a><a href="#rootly">Rootly</a><a href="#generic">Generic CSV</a><a href="#people">People and hours</a><a href="#score">Burnout score</a><a href="#noise">Noise rules</a><a href="#privacy">Privacy</a>
      </nav>

      <h2 id="pagerduty">PagerDuty: incidents CSV</h2>
      <ol>
        <li>Go to <strong>Incidents</strong> (or <strong>Analytics → Insights → Incident Activity</strong> on plans with Analytics).</li>
        <li>Filter to your team or services, set the date range to the quarter, and include resolved incidents.</li>
        <li>Choose <strong>Download CSV</strong> (Analytics: <strong>Export → CSV</strong>).</li>
      </ol>
      <p>Columns used: <code>id</code> or <code>incident_number</code>, <code>description</code> or <code>title</code>, <code>service_name</code>, <code>urgency</code>, <code>created_on</code> or <code>created_at</code>, <code>resolved_on</code>/<code>resolved_at</code>, <code>seconds_to_first_ack</code>, <code>seconds_to_resolve</code>, <code>acknowledged_by</code> (falls back to <code>assigned_to</code> for pages nobody acked) and <code>auto_resolved</code>. The person paged is the acknowledger when there is one.</p>

      <h2 id="pagerduty-api">PagerDuty: REST API (/incidents and /log_entries)</h2>
      <p>Use a read-only API key (<strong>Integrations → API Access Keys</strong>). The API caps the window per request, so fetch a quarter in pages of 100 and drop all the JSON files in at once.</p>
      <Code label="shell" code={PD_API} />
      <p>Import the <code>/incidents</code> files first. Then import the <code>/log_entries</code> files: they add who was actually notified (<code>notify_log_entry</code>), the first <code>acknowledge_log_entry</code>, and mark incidents whose <code>resolve_log_entry</code> came from an integration rather than a user as auto-resolved.</p>

      <h2 id="opsgenie">Opsgenie: alerts CSV</h2>
      <ol>
        <li>Open <strong>Alerts</strong>, switch the list to the quarter (search, e.g. <code>createdAt &gt; 01-07-2026</code>) and your team.</li>
        <li>Use <strong>Export → CSV</strong> on the alert list.</li>
      </ol>
      <p>Columns used: <code>TinyId</code>, <code>Alias</code> (used as the dedupe key), <code>Message</code>, <code>CreatedAt</code>, <code>Priority</code> (P1 to P3 count as high urgency, P4 and P5 as low), <code>AcknowledgedBy</code> then <code>Owner</code>, <code>AckTime</code> and <code>CloseTime</code> (milliseconds after creation), <code>ClosedBy</code> (closed by an API, integration or policy means auto-resolved) and <code>Tags</code>. A tag like <code>non-actionable</code>, <code>noise</code> or <code>false-positive</code> marks the alert as non-actionable.</p>

      <h2 id="rootly">Rootly: incidents CSV or API</h2>
      <ol>
        <li>In Rootly, open <strong>Incidents</strong>, filter to the quarter and team, and export to CSV.</li>
        <li>Or use the API with a read-only key (JSON:API format):</li>
      </ol>
      <Code label="shell" code={ROOTLY_API} />
      <p>Columns used: <code>started_at</code> (or <code>created_at</code>), <code>title</code>/<code>summary</code>, <code>services</code>, <code>severity</code> (SEV0 to SEV2 high, SEV3+ low), <code>acknowledged_at</code>, <code>resolved_at</code> (else <code>mitigated_at</code>) and the commander or creator as the person. Nested JSON:API objects are flattened to their names.</p>

      <h2 id="generic">Generic CSV</h2>
      <p>Any CSV with at least a timestamp and a title. Timestamps may be ISO 8601 with or without an offset (no offset means UTC), epoch seconds or milliseconds, or <code>M/D/YYYY h:mm</code>.</p>
      <Code label="incidents.csv" code={GENERIC} />
      <div className="table-wrap"><table>
        <thead><tr><th>Field</th><th>Recognized column names</th></tr></thead>
        <tbody>{FIELDS.map(f => <tr key={f.key}><th scope="row">{f.label}{f.required ? ' *' : ''}</th><td className="small"><code>{f.aliases.join(', ')}</code></td></tr>)}</tbody>
      </table></div>

      <h2 id="people">People, timezones and working hours</h2>
      <p>Everyone who appears in an import is added with the team&rsquo;s default timezone and 09:00 to 17:30, Monday to Friday. Set each person&rsquo;s real timezone (IANA names like <code>Europe/London</code>; daylight saving is handled) and hours on the Data &amp; people tab. Turn off <em>In rotation</em> for managers or people who left, so they don&rsquo;t distort fairness. Add people who were on the rotation but never paged: a zero counts toward the fair share.</p>
      <p>Each page lands in exactly one bucket, checked in this order: <strong>sleep hours</strong> (default 22:00 to 07:00 local, configurable), then <strong>weekends</strong> (any non-working day), then <strong>business hours</strong>, and anything left is an <strong>evening</strong>. A 03:00 page counts toward the previous night.</p>

      <h2 id="score">The burnout-risk score</h2>
      <p>A transparent 0 to 100 score per person, computed over the selected period and scaled to a week or month so quarters and months compare:</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Part</th><th>Formula</th><th className="num">Max</th></tr></thead>
        <tbody>
          <tr><th scope="row">Sleep interruptions</th><td>pages in sleep hours per week × 10</td><td className="num">40</td></tr>
          <tr><th scope="row">Consecutive bad nights</th><td>(longest run of nights with a sleep page − 1) × 25/3</td><td className="num">25</td></tr>
          <tr><th scope="row">Days off interrupted</th><td>distinct non-working days with any page, per 30 days × 4</td><td className="num">20</td></tr>
          <tr><th scope="row">Evenings</th><td>evening pages per week × 3</td><td className="num">15</td></tr>
        </tbody>
      </table></div>
      <p>Bands: under 20 low, 20 to 44 moderate, 45 to 69 high, 70+ severe. It is a conversation starter, not a diagnosis. The weights encode a simple belief: broken sleep, especially several nights running, does the most damage.</p>
      <p><strong>Fairness</strong> uses the Gini coefficient over page counts of people in the rotation (0 = perfectly even; with 4 people, 0.75 means one person carries everything). A second Gini weights pages by when they land: business 1, evening 1.5, weekend 2, sleep 3. Each person&rsquo;s share is compared with a fair share of 1/N.</p>

      <h2 id="noise">Noise rules and suggested fixes</h2>
      <p>Pages are grouped into alerts by the source&rsquo;s dedupe key, or by service plus the title with numbers, IDs and IP addresses masked. For each alert:</p>
      <ul>
        <li><strong>Delete or route away</strong>: at least half its pages are marked non-actionable.</li>
        <li><strong>Dedupe key</strong>: pages that fired while an earlier page for the same alert was still open (duplicates), plus re-firings within the flapping window (default 60 min) once the chain reaches 3 firings. The first page of each chain stays.</li>
        <li><strong>Escalation delay</strong>: at least 30% resolved on their own in under N minutes (default 5) without a human ack. A delay of N minutes removes exactly those.</li>
        <li><strong>Dependency</strong>: at least 60% of its pages fired within 10 minutes after the same upstream alert on another service. Suppressing it while the upstream is open removes them.</li>
        <li><strong>Downgrade to low urgency</strong>: at least 60% were never acknowledged. Low urgency still notifies in working hours, so only the off-hours pages are counted as removed.</li>
      </ul>
      <p>Fixes are ranked by pages removed per month, with sleep-hours pages counting three times. Toggle any fix as a what-if and every view, including the rotation simulator and pay, recomputes without those pages.</p>

      <h2 id="privacy">Where your data goes</h2>
      <p>Files are parsed in your browser. Teams are stored in this browser&rsquo;s IndexedDB. If you sign in (optional), people, thresholds, fixes, snapshots and incident lists under 1.5 MB per team sync to your account; larger lists stay on the device. You can export everything as JSON or delete your cloud data and account from the account menu. <Link href="/settings">Settings</Link></p>
    </section>
  )
}
