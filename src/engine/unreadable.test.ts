import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FORMATS, looksBinary, parseFile, type Format } from './parse.ts'

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')
const decode = (bytes: number[] | Buffer) => new TextDecoder().decode(Buffer.from(bytes))
const PNG = decode([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0xff, 0xfe])

const EMPTY = 'This file is empty.'
const NOT_TEXT = /^This is not a UTF-8 text file/
const NO_ROWS = 'This file has a header line but no data rows.'
const ONE_COLUMN = /^This does not look like a table: the first line has one column/

/** The one thing an unreadable file reports: no counts, no mapping errors. */
function assertUnreadable(text: string, message: string | RegExp, opts: Parameters<typeof parseFile>[1] = {}) {
  const r = parseFile(text, opts)
  assert.equal(r.unreadable, true)
  assert.equal(r.ok, 0)
  assert.equal(r.issues.length, 1)
  assert.equal(r.issues[0].level, 'error')
  assert.equal(r.issues[0].line, 0)
  if (typeof message === 'string') assert.equal(r.issues[0].message, message); else assert.match(r.issues[0].message, message)
  assert.equal(r.fleet, undefined)
  assert.equal(r.jobs, undefined)
  return r
}

test('an empty file, or one with only whitespace or a byte-order mark, is empty in every format', () => {
  for (const text of ['', '\n', '  \r\n\t \n', '\ufeff', '\ufeff\n\n']) {
    assertUnreadable(text, EMPTY)
    for (const format of Object.keys(FORMATS) as Format[]) assertUnreadable(text, EMPTY, { format })
  }
})

test('binary data, an image or UTF-16 text is called not text, also when a JSON or scrape format is forced', () => {
  const utf16 = decode(Buffer.from('timestamp,hostname,gpu,dcgm_fi_prof_sm_active\n2026-11-12T10:00:00,n1,0,0.5\n', 'utf16le'))
  const noise = decode(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256))
  for (const text of [PNG, utf16, noise, '\0\0\0\0']) {
    assertUnreadable(text, NOT_TEXT)
    for (const format of ['prom-json', 'prom-text', 'k8s-json', 'sacct', 'prom-csv'] as Format[]) assertUnreadable(text, NOT_TEXT, { format })
  }
  assert.equal(looksBinary(PNG), true)
  assert.equal(looksBinary(utf16), true)
})

test('a header with no data rows says so, for metrics and for jobs, with CRLF or trailing blank lines', () => {
  assertUnreadable('timestamp,hostname,gpu,dcgm_fi_prof_sm_active\n', NO_ROWS)
  assertUnreadable('timestamp,hostname,gpu,dcgm_fi_prof_sm_active\r\n\r\n\r\n', NO_ROWS)
  assertUnreadable('JobID|JobName|User|Account|Start|End|NodeList|AllocTRES\n', NO_ROWS)
  assertUnreadable('timestamp, index, utilization.gpu [%], memory.used [MiB]\n', NO_ROWS)
  assertUnreadable('job_id,user,account,start,end,gpus,nodelist', NO_ROWS)
  assertUnreadable('nothing useful', NO_ROWS)
})

test('text with a single column is not a table', () => {
  assertUnreadable('hello\nworld\nagain\n', ONE_COLUMN)
  assertUnreadable('2026-11-12T10:00:00\n2026-11-12T10:05:00\n', ONE_COLUMN)
})

test('text with no rows once quoting is applied is reported, not mapped', () => {
  assertUnreadable('"', 'This file has no readable rows.')
})

test('what was already explained well is unchanged', () => {
  // Rows exist but no column matches: the mapping form and its errors are still the right answer.
  const notes = parseFile('hello world\nthis is not telemetry\n', { fileName: 'notes.txt' })
  assert.equal(notes.unreadable, undefined)
  assert.equal(notes.total, 1)
  assert.equal(notes.skipped, 1)
  assert.ok(notes.issues.some(i => i.message === 'Map a column to "Timestamp" to import this file.'))
  assert.equal(notes.headers.length, 2)
  // JSON that is not a Prometheus or kubectl body.
  const other = parseFile('{"hello":[1,2,3]}', { fileName: 'other.json' })
  assert.equal(other.unreadable, undefined)
  assert.match(other.issues[0].message, /^No pods found/)
  // Truncated JSON still throws the parser's own message, which the page shows as an error.
  assert.throws(() => parseFile('{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"DCGM_FI_DEV_GPU_UTIL","gpu":"0"},"values":[[1790000000,"1"],[17900', { fileName: 't.json' }), /Expected/)
  // A scrape with no DCGM metrics keeps its own message.
  assert.match(parseFile('# HELP up x\nup 1\n', { format: 'prom-text' }).issues.at(-1)!.message, /^No DCGM metrics found/)
})

test('files that import today still import, even with stray bad bytes, NUL padding or accents', () => {
  const good = 'timestamp,hostname,gpu,dcgm_fi_prof_sm_active\n2026-11-12T10:00:00,n1,0,0.5\n2026-11-12T10:05:00,n1,0,0.6\n'
  assert.equal(parseFile(good, { fileName: 'g.csv' }).ok, 2)
  assert.equal(parseFile(good + '\0'.repeat(500), { fileName: 'g.csv' }).ok, 2)
  assert.equal(parseFile(good.replace('n1', 'n\ufffd1'), { fileName: 'g.csv' }).ok, 2)
  assert.equal(parseFile('\ufeff' + good, { fileName: 'g.csv' }).ok, 2)
  assert.equal(parseFile(good.replace(/\n/g, '\r\n'), { fileName: 'g.csv' }).ok, 2)
  assert.equal(parseFile(good.replace(/,/g, ';'), { fileName: 'g.csv' }).ok, 2)
  const r = parseFile(good + '\0'.repeat(500), { fileName: 'g.csv' })
  assert.equal(r.unreadable, undefined)
  assert.equal(parseFile(fixture('dcgm-exporter-4.9.prom'), { fileName: 'x.prom' }).ok, 11)
  assert.equal(parseFile(fixture('sacct-mixed.psv'), { fileName: 'x.psv' }).ok, 4)
  assert.equal(parseFile(fixture('nvidia-smi-noindex.csv'), { fileName: 'nvidia-smi-noindex.csv' }).ok, 6)
})

test('a one-column header cannot supply the required columns, so it is called a one-column file', () => {
  assertUnreadable('timestamp\n2026-11-12T10:00:00,n1,0,0.5\n', ONE_COLUMN)
})
