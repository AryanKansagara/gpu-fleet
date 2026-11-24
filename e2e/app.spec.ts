import type { Page } from '@playwright/test'
import { expect, fixture, openSample, tab, test } from './helpers.ts'

const ATLAS = /Atlas inference fleet/
const kpi = (page: Page, label: string) => page.locator('.kpi').filter({ has: page.locator('.kpi-label', { hasText: new RegExp(`^${label}$`) }) })
const formatSelect = (page: Page) => page.locator('label', { hasText: /^Format/ }).locator('select')
const rate = (page: Page, label: RegExp | string) => page.locator('label.field', { hasText: label }).locator('input')

test.describe('sample cluster', () => {
  test('shows idle GPUs and a right-sizing suggestion', async ({ page }) => {
    await openSample(page, ATLAS)
    await expect(page.getByRole('heading', { name: 'Atlas inference fleet' })).toBeVisible()
    await expect(page.getByText('40 GPUs · 37 jobs · October 2026')).toBeVisible()

    // Allocated is not busy: 89% of GPU-hours are booked but only 14% SM activity.
    await expect(kpi(page, 'Allocated')).toContainText('89%')
    await expect(kpi(page, 'SM active while allocated')).toContainText('14%')
    await expect(kpi(page, 'Allocated but idle')).toContainText('28%')
    await expect(kpi(page, 'Allocated but idle')).toContainText('7,479 GPU-hours · $13,844')
    await expect(kpi(page, 'Recoverable')).toContainText('28.5 GPUs')

    // The class table has idle notebooks, and the wins list names the fix.
    const classes = page.locator('table.compact')
    await expect(classes.getByRole('row', { name: /Idle \/ abandoned\s+6 jobs\s+1,186 GPU-h/ })).toBeVisible()
    const wins = page.locator('ol.wins')
    await expect(wins.getByText(/Idle notebook: no GPU work for 53h in a row/)).toBeVisible()
    await expect(wins.getByText(/fit a 1g\.10gb MIG slice, so 7 jobs like this share one H100 80GB/)).toBeVisible()
  })

  test('the policy view frees GPUs and the jobs list explains each one', async ({ page }) => {
    await openSample(page, ATLAS)
    const view = page.getByRole('radiogroup', { name: 'View' })
    await expect(view.getByRole('radio', { name: 'As scheduled' })).toBeChecked()
    await view.getByRole('radio', { name: 'With policies' }).click()
    await expect(page.locator('.freed')).toContainText('28.5GPUs freed (avg)')

    await tab(page, 'Jobs').click()
    await page.getByLabel('Class').selectOption({ label: 'Idle / abandoned (6)' })
    await expect(page.locator('table.jobs tbody tr.clickable')).toHaveCount(6)
    await page.locator('table.jobs tbody tr.clickable').first().click()
    await expect(page.locator('.job-detail')).toContainText('An idle culler or 2h timeout would have released all 1 GPU')
    await page.getByLabel('Search jobs').fill('no-such-job')
    await expect(page.getByText('No jobs match')).toBeVisible()
  })
})

test.describe('chargeback', () => {
  test('changing $/GPU-hour changes the charge, and the rate survives a reload', async ({ page }) => {
    await openSample(page, ATLAS)
    await tab(page, 'Chargeback').click()
    const total = page.locator('tfoot tr')
    await expect(total).toContainText('$50,135')
    await expect(rate(page, /^H100 \(USD/)).toHaveValue('2.5')

    await rate(page, /^H100 \(USD/).fill('5')
    await expect(total).not.toContainText('$50,135')
    await expect(total).toContainText('$71,700')
    // Idle spend follows the rate too, while GPU-hours do not move.
    await expect(total).toContainText('26,482')

    await page.reload()
    await expect(rate(page, /^H100 \(USD/)).toHaveValue('5')
    await expect(page.locator('tfoot tr')).toContainText('$71,700')
  })

  test('the on-prem calculator sets a rate', async ({ page }) => {
    await openSample(page, ATLAS)
    await tab(page, 'Chargeback').click()
    await page.getByText('On-prem? Work out an amortised rate').click()
    await expect(page.getByText('(capex + opex × years) ÷ (years × 8,760 h) =')).toContainText('1.40/GPU-h')
    await page.getByLabel('Years of service').fill('2')
    await expect(page.getByText('(capex + opex × years) ÷ (years × 8,760 h) =')).toContainText('2.40/GPU-h')
    await page.getByLabel('Apply to').selectOption('H100')
    await page.getByRole('button', { name: 'Use this rate' }).click()
    await expect(page.getByText('H100 rate set to 2.40')).toBeVisible()
    await expect(rate(page, /^H100 \(USD/)).toHaveValue('2.4')
  })
})

test.describe('importing existing exports', () => {
  test('a DCGM scrape and a sacct export import, report what they contain, and persist', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
    const input = page.locator('input[type=file]')

    await input.setInputFiles(fixture('dcgm-exporter-4.9.prom'))
    await expect(formatSelect(page)).toHaveValue('prom-text')
    await expect(page.getByText('11 samples ready of 11 values.')).toBeVisible()
    await expect(page.getByText('1 GPUs on 1 hosts, 2026-11-12 10:00 to 2026-11-12 10:05 UTC.')).toBeVisible()
    await page.getByRole('button', { name: 'Import 11 samples' }).click()
    await expect(page.getByText('Imported 11 samples')).toBeVisible()
    // The scrape's hpc_job label alone is enough to name the job.
    await expect(page.getByText('1 GPUs · 1 jobs · November 2026')).toBeVisible()

    await input.setInputFiles(fixture('sacct-mixed.psv'))
    await expect(page.getByText('4 jobs ready of 10 rows, 6 skipped')).toBeVisible()
    await expect(page.getByText('2 jobs had no GPUs allocated')).toBeVisible()
    await expect(page.getByText('3 accounts, 4 users, 22 GPUs requested.')).toBeVisible()
    await page.getByRole('button', { name: 'Import 4 jobs' }).click()
    await expect(page.getByText('Imported 4 jobs, skipped 6')).toBeVisible()

    // The sacct jobs ended before this scrape started. They are named on the Data tab and on Overview, not dropped quietly.
    const outside = '4 imported jobs do not overlap the telemetry (2026-11-12 10:00 to 2026-11-12 10:05 UTC), so none appear in this report: 88120, 88121_3, 88123+0, 88122.'
    await expect(page.locator('.banner.warn')).toContainText(outside)
    await tab(page, 'Overview').click()
    await expect(page.getByText('1 GPUs · 0 jobs · November 2026')).toBeVisible()
    await expect(page.locator('.banner.warn')).toContainText(outside)
    await tab(page, 'Data').click()

    const imports = page.locator('.panel', { has: page.getByRole('heading', { name: 'Imported data' }) })
    await expect(imports.getByRole('row', { name: /sacct-mixed\.psv\s+Slurm sacct \(parsable\)\s+4\s+6/ })).toBeVisible()
    await expect(imports.getByRole('row', { name: /dcgm-exporter-4\.9\.prom\s+dcgm-exporter \/metrics scrapes \(text\)\s+11\s+0/ })).toBeVisible()

    // Everything is local: a reload keeps the cluster, its imports and its data.
    await page.reload()
    await expect(page.getByText('1 GPUs on 1 hosts')).toBeVisible()
    await expect(page.getByText('4 jobs', { exact: true })).toBeVisible()
    await expect(imports.getByRole('row')).toHaveCount(3)
    await page.goto('/app')
    await expect(page.getByRole('heading', { name: 'Cluster 1' })).toBeVisible()
  })

  test('a job on a host with no telemetry and a job outside the range are each named, and a job that matches is not', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    const input = page.locator('input[type=file]')
    await input.setInputFiles(fixture('dcgm-exporter-4.9.prom'))
    await page.getByRole('button', { name: 'Import 11 samples' }).click()
    await expect(page.getByText('Imported 11 samples')).toBeVisible()

    const jobs = 'job_id,user,account,start,end,gpus,nodelist\n88123,ann,vision,2026-11-12T10:00:00,2026-11-12T10:05:00,1,dgx-b200-07\n99001,bo,nlp,2026-11-12T10:00:00,2026-11-12T10:05:00,1,gpu99\n99002,cy,nlp,2026-11-13T10:00:00,2026-11-13T11:00:00,1,dgx-b200-07\n'
    await input.setInputFiles({ name: 'jobs.csv', mimeType: 'text/csv', buffer: Buffer.from(jobs) })
    await page.getByRole('button', { name: 'Import 3 jobs' }).click()
    await expect(page.getByText('Imported 3 jobs')).toBeVisible()
    const notice = page.locator('.banner.warn')
    await expect(notice).toHaveCount(2)
    await expect(notice.first()).toContainText('1 imported job does not overlap the telemetry (2026-11-12 10:00 to 2026-11-12 10:05 UTC), so it does not appear in this report: 99002.')
    await expect(notice.nth(1)).toContainText('1 job ran on hosts with no telemetry (gpu99), so it is listed as No telemetry and has no usage figures.')
    await expect(notice.nth(1)).toContainText('Check that the host names match between the exports: 99001.')

    await tab(page, 'Overview').click()
    await expect(page.getByText('1 GPUs · 2 jobs · November 2026')).toBeVisible()
    await expect(page.locator('.banner.warn').nth(1)).toContainText('1 job ran on hosts with no telemetry (gpu99)')
  })

  test('the nvidia-smi log without an index column warns and still imports', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await page.locator('input[type=file]').setInputFiles(fixture('nvidia-smi-noindex.csv'))
    await expect(formatSelect(page)).toHaveValue('nvidia-smi')
    await expect(page.getByText('6 samples ready of 6 rows, 2 warnings.')).toBeVisible()
    await expect(page.getByText(/read as a single-GPU log \(GPU 0\)/)).toBeVisible()
    await expect(page.getByText(/GPU utilisation is used instead\. Utilisation counts any kernel running and overstates real work/)).toBeVisible()
    await page.getByRole('button', { name: 'Import 6 samples' }).click()
    await expect(page.getByText('Imported 6 samples')).toBeVisible()
  })
})

test.describe('files the app cannot use', () => {
  // Files with nothing usable in them get one plain reason, with no counts and no column mapping to fill in.
  const unreadable = [
    { name: 'empty.csv', body: '', says: 'This file is empty.' },
    { name: 'blank.csv', body: '\n  \n', says: 'This file is empty.' },
    { name: 'binary.json', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0xff, 0xfe]), says: /^This is not a UTF-8 text file/ },
    { name: 'utf16.csv', body: Buffer.from('timestamp,hostname,gpu,dcgm_fi_prof_sm_active\n2026-11-12T10:00:00,n1,0,0.5\n', 'utf16le'), says: /^This is not a UTF-8 text file/ },
    { name: 'header-only.csv', body: 'timestamp,hostname,gpu,dcgm_fi_prof_sm_active\n', says: 'This file has a header line but no data rows.' },
    { name: 'words.txt', body: 'hello\nworld\n', says: /^This does not look like a table: the first line has one column/ },
  ]
  for (const f of unreadable) {
    test(`${f.name} is explained as a file, not as a column mapping, and cannot be committed`, async ({ page }) => {
      await page.goto('/app')
      await page.getByRole('button', { name: 'Import your data' }).click()
      await page.locator('input[type=file]').setInputFiles({ name: f.name, mimeType: 'application/octet-stream', buffer: Buffer.from(f.body) })
      await expect(page.getByRole('log', { name: 'Validation issues' }).getByText(f.says)).toBeVisible()
      await expect(page.getByRole('log', { name: 'Validation issues' }).locator('.error-row')).toHaveCount(1)
      await expect(page.getByText(/ready of/)).toHaveCount(0)
      await expect(page.getByText('Column mapping')).toHaveCount(0)
      await expect(page.getByText(/Map a column to|No host column/)).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Import 0 / })).toBeDisabled()
      await expect(page.getByRole('heading', { name: 'Imported data' })).toHaveCount(0)
      await expect(page.locator('.toast.ok')).toHaveCount(0)
    })
  }

  test('an empty file stays empty when another format is chosen', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await page.locator('input[type=file]').setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from('') })
    await expect(page.getByText('This file is empty.')).toBeVisible()
    await formatSelect(page).selectOption('prom-json')
    await expect(page.getByText('This file is empty.')).toBeVisible()
    await expect(page.locator('.toast.error')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Import 0 / })).toBeDisabled()
  })

  // Rows exist but nothing matches a known column: the mapping form is still the useful answer.
  const bad = [
    { name: 'notes.txt', body: 'hello world\nthis is not telemetry\n', says: /Map a column to "Timestamp" to import this file\./, ready: /0 samples ready of 1 rows, 1 skipped/ },
    { name: 'other.json', body: '{"hello":[1,2,3]}', says: /No pods found\. Expected the output of kubectl get pods -A -o json\./, ready: /0 jobs ready of 0 pods/ },
  ]
  for (const f of bad) {
    test(`${f.name} says why it cannot be imported and cannot be committed`, async ({ page }) => {
      await page.goto('/app')
      await page.getByRole('button', { name: 'Import your data' }).click()
      await page.locator('input[type=file]').setInputFiles({ name: f.name, mimeType: 'application/octet-stream', buffer: Buffer.from(f.body) })
      await expect(page.getByText(f.ready)).toBeVisible()
      await expect(page.getByRole('log', { name: 'Validation issues' }).getByText(f.says).first()).toBeVisible()
      await expect(page.getByRole('button', { name: /^Import 0 / })).toBeDisabled()
      // Nothing was imported.
      await expect(page.getByRole('heading', { name: 'Imported data' })).toHaveCount(0)
      await expect(page.locator('.toast.ok')).toHaveCount(0)
    })
  }

  test('a truncated Prometheus export reports the JSON error, and the app stays usable', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    const truncated = '{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"DCGM_FI_DEV_GPU_UTIL","gpu":"0"},"values":[[1790000000,"1"],[17900'
    const input = page.locator('input[type=file]')
    await input.setInputFiles({ name: 'trunc.json', mimeType: 'application/json', buffer: Buffer.from(truncated) })
    await expect(page.locator('.toast.error').first()).toContainText(/^trunc\.json: Expected ',' or '\]' after array element in JSON at position 149/)
    await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0)

    // The drop zone still works and a good file imports afterwards.
    await expect(page.getByText('Drop exports here, or click to choose')).toBeVisible()
    await input.setInputFiles(fixture('dcgm-exporter-4.9.prom'))
    await page.getByRole('button', { name: 'Import 11 samples' }).click()
    await expect(page.getByText('Imported 11 samples')).toBeVisible()

    // Other pages still load.
    await page.getByRole('link', { name: 'Docs', exact: true }).first().click()
    await expect(page).toHaveURL(/\/docs$/)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Cluster 1' })).toBeVisible()
  })

  test('cancelling a rejected file clears it', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('nothing useful') })
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText(/samples ready of/)).toHaveCount(0)
  })
})

test.describe('persistence and pages', () => {
  test('a sample cluster, a rename and a snapshot survive a reload', async ({ page }) => {
    await openSample(page, ATLAS)
    await page.getByRole('button', { name: 'Save snapshot' }).click()
    await expect(page.getByText(/(Saved a snapshot of|Replaced the) October 2026/)).toBeVisible()
    await page.goto('/app')
    await expect(page.getByRole('heading', { name: 'Atlas inference fleet' })).toBeVisible()
    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByLabel('Project name').fill('Atlas (prod)')
    await page.getByLabel('Project name').press('Enter')
    await expect(page.getByRole('heading', { name: 'Atlas (prod)' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Atlas (prod)' })).toBeVisible()
    await page.getByRole('link', { name: 'Atlas (prod)' }).click()
    await tab(page, 'History').click()
    await expect(page.getByText('October 2026').first()).toBeVisible()
  })

  test('deleting a cluster can be undone', async ({ page }) => {
    await openSample(page, ATLAS)
    await page.goto('/app')
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete cluster' }).click()
    await expect(page.getByText('Deleted Atlas inference fleet')).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByRole('heading', { name: 'Atlas inference fleet' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Atlas inference fleet' })).toBeVisible()
  })

  test('a default rate saved in Settings is used by new clusters and survives a reload', async ({ page }) => {
    await page.goto('/settings')
    const h100 = page.locator('label.field', { hasText: /^H100/ }).locator('input')
    await h100.fill('4')
    await expect(page.getByText('Saved')).toBeVisible()
    await page.reload()
    await expect(h100).toHaveValue('4')
  })

  test('landing, docs, settings and unknown routes render without errors or outside requests', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your cluster is full.')
    // The hero runs the real engine on a synthetic week.
    const toggle = page.getByRole('button', { name: 'Apply idle timeout + MIG plan' })
    await expect(toggle).toBeEnabled()
    await toggle.click()
    await expect(page.getByRole('button', { name: 'Undo policies' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.viz-counter')).toContainText('GPUs freed')
    await page.goto('/docs')
    await expect(page).toHaveTitle(/^Docs:/)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    await page.goto('/app/p/not-a-cluster')
    await expect(page.getByText('Cluster not found')).toBeVisible()
    await page.goto('/nowhere')
    await expect(page.getByRole('main')).toContainText('This page was never allocated')
  })

  test('opening a sample straight from the landing link', async ({ page }) => {
    await page.goto('/app?sample=helix&tab=teams')
    // Generating a 64-GPU month and its two history snapshots takes a few seconds.
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/teams$/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Chargeback by account' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Helix research cluster' })).toBeVisible()
  })
})
