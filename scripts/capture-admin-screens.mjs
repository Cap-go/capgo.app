import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(rootDir, '.context/admin-screens')
const DOCS = join(rootDir, 'docs/pr-assets/admin-intention-ia')
const BASE = 'http://localhost:5173'

mkdirSync(OUT, { recursive: true })
mkdirSync(DOCS, { recursive: true })

async function waitForAdmin(page, path, readyLocator) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL((url) => {
    try {
      return new URL(url).pathname.replace(/\/$/, '') === path.replace(/\/$/, '')
    }
    catch {
      return false
    }
  }, { timeout: 120000 })
  await page.getByRole('button', { name: /onboarding|pulse|product/i }).first().waitFor({ timeout: 120000 })
  if (readyLocator)
    await readyLocator(page).waitFor({ timeout: 120000 })
  // give charts a moment
  await page.waitForTimeout(3000)
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
  await page.screenshot({ path: join(DOCS, `${name}.png`), fullPage: false })
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

await waitForAdmin(page, '/admin/dashboard/pulse', p => p.getByText(/new registrations|pulse/i).first())
await shot(page, 'real-pulse')

await waitForAdmin(page, '/admin/dashboard/onboarding', p => p.getByRole('button', { name: /funnel|sources|cohorts/i }).first())
await shot(page, 'real-onboarding-funnel')

await waitForAdmin(page, '/admin/dashboard/onboarding/sources', p => p.getByText(/registrations by source|sources/i).first())
await shot(page, 'real-onboarding-sources')

await waitForAdmin(page, '/admin/dashboard/onboarding/cohorts', p => p.getByRole('button', { name: /cohorts/i }).first())
await shot(page, 'real-onboarding-cohorts')

await waitForAdmin(page, '/admin/dashboard/product/updates', p => p.getByRole('button', { name: /updates|plugins|cli/i }).first())
await shot(page, 'real-product-updates')

await waitForAdmin(page, '/admin/dashboard/retention', p => p.getByRole('button', { name: /trials|churn|inactive/i }).first())
await shot(page, 'real-retention')

await waitForAdmin(page, '/admin/dashboard/customers/organizations', p => p.getByRole('button', { name: /organizations|credits/i }).first())
await shot(page, 'real-customers')
await browser.close()
