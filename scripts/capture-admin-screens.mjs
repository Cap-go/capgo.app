import { chromium } from '@playwright/test'

const OUT = '/opt/cursor/artifacts/admin-reorg'
const DOCS = '/workspace/docs/pr-assets/admin-intention-ia'
const BASE = 'http://localhost:5173'

async function waitForAdmin(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /onboarding|pulse|product/i }).first().waitFor({ timeout: 120000 })
  // give charts a moment
  await page.waitForTimeout(3000)
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  await page.screenshot({ path: `${DOCS}/${name}.png`, fullPage: false })
  console.log('saved', name, page.url())
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
page.setDefaultTimeout(120000)

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.locator('input[type="email"]').first().fill('admin@capgo.app')
await page.getByRole('button', { name: /continue/i }).first().click()
await page.locator('input[type="password"]').first().waitFor({ state: 'visible' })
await page.locator('input[type="password"]').first().fill('adminadmin')
await page.getByRole('button', { name: /log in/i }).first().click()
await page.waitForURL(u => !String(u).includes('/login'), { timeout: 90000 })
console.log('logged in', page.url())

await waitForAdmin(page, '/admin/dashboard/pulse')
await shot(page, 'real-pulse')

await waitForAdmin(page, '/admin/dashboard/onboarding')
await shot(page, 'real-onboarding-funnel')

await waitForAdmin(page, '/admin/dashboard/onboarding/sources')
await shot(page, 'real-onboarding-sources')

await waitForAdmin(page, '/admin/dashboard/onboarding/cohorts')
await shot(page, 'real-onboarding-cohorts')

await waitForAdmin(page, '/admin/dashboard/product/updates')
await shot(page, 'real-product-updates')

await waitForAdmin(page, '/admin/dashboard/retention')
await shot(page, 'real-retention')

await waitForAdmin(page, '/admin/dashboard/customers/organizations')
await shot(page, 'real-customers')

await browser.close()
