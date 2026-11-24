import { test as base, expect, type Page } from '@playwright/test'

/** Only Google Fonts is requested by the app when signed out. It is answered with an empty stylesheet. */
const STUBBED = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/**
 * Every test runs signed out with the network closed to anything but the preview server.
 * Requests to other hosts are stubbed (fonts) or aborted, and a test fails if the page threw,
 * logged a console error, or asked for a host outside the stub list (for example Supabase).
 */
export const test = base.extend<{ guard: void }>({
  guard: [async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    const external: string[] = []
    const problems: string[] = []
    await page.context().route(url => url.origin !== origin, route => {
      const u = new URL(route.request().url())
      if (STUBBED.has(u.hostname)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      external.push(u.origin)
      return route.abort()
    })
    page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`) })
    await use()
    expect(external, 'requests to hosts outside the preview server').toEqual([])
    expect(problems, 'uncaught page errors and console errors').toEqual([])
  }, { auto: true }],
})

export { expect }

export const fixture = (name: string) => new URL(`../src/engine/fixtures/${name}`, import.meta.url).pathname

/** Opens a synthetic sample from the Clusters page, the way a first-time visitor does. */
export async function openSample(page: Page, name: RegExp | string) {
  await page.goto('/app')
  await page.getByRole('button', { name }).click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
  await expect(page.locator('.kpis')).toBeVisible()
}

export const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Cluster sections' }).getByRole('link', { name, exact: true })
