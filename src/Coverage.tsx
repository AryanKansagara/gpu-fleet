import { useMemo } from 'react'
import { jobCoverage } from './engine/analyze.ts'
import type { Dataset } from './store.ts'

const utc = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const names = (xs: string[], max = 5) => xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', ')

/** Says so when imported jobs cannot be joined to the telemetry, instead of leaving them out of the report without a word. */
export default function CoverageNotice({ ds }: { ds: Dataset }) {
  const c = useMemo(() => ds.fleet?.n && ds.jobs.length ? jobCoverage(ds.fleet, ds.jobs) : null, [ds])
  if (!c || (!c.outside.length && !c.unmatched.length)) return null
  const out = c.outside.length, un = c.unmatched.length
  return (
    <>
      {out > 0 && (
        <div className="banner warn"><span>
          <strong>{out.toLocaleString()} imported job{out === 1 ? ' does' : 's do'} not overlap the telemetry</strong> ({utc(c.from)} to {utc(c.to)} UTC), so {out === 1 ? 'it does not appear' : 'none appear'} in this report: {names(c.outside.map(j => j.id))}. Import telemetry that covers the jobs&rsquo; dates to include them.
        </span></div>
      )}
      {un > 0 && (
        <div className="banner warn"><span>
          <strong>{un.toLocaleString()} job{un === 1 ? '' : 's'} ran on hosts with no telemetry</strong> ({names(c.unmatchedHosts)}), so {un === 1 ? 'it is' : 'they are'} listed as No telemetry and {un === 1 ? 'has' : 'have'} no usage figures. Check that the host names match between the exports: {names(c.unmatched.map(j => j.id))}.
        </span></div>
      )}
    </>
  )
}
