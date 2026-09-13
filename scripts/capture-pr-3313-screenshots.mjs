import { chromium } from '@playwright/test'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'

const EMAIL = process.env.CAPGO_SCREENSHOT_EMAIL ?? 'test@capgo.app'
const PASSWORD = process.env.CAPGO_SCREENSHOT_PASSWORD ?? 'testtest'
const OUT_DIR = path.resolve('docs/pr-screenshots/3313')
const AFTER_BASE = process.env.CAPGO_AFTER_BASE_URL ?? 'http://127.0.0.1:5173'
const APP_ID = process.env.CAPGO_SCREENSHOT_APP_ID ?? 'com.demo.app'
const CHANNEL_ID = process.env.CAPGO_SCREENSHOT_CHANNEL_ID ?? '1'
const BUNDLE_ID = process.env.CAPGO_SCREENSHOT_BUNDLE_ID ?? '6'

const PREPROD_SUPABASE_URL = 'https://ibwjdnhknbkcqfbabwei.supabase.co'
const PREPROD_ANON_KEY = 'sb_publishable_q_TJ5x2krpmTYIcRDknJJQ_fvKFqKYz'
const PREPROD_STORAGE_KEY = 'sb-ibwjdnhknbkcqfbabwei-auth-token'

async function fetchPreprodSession() {
  const response = await fetch(`${PREPROD_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: PREPROD_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token)
    throw new Error(`Preprod auth failed: ${data.msg || data.error_description || response.status}`)
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    expires_in: data.expires_in ?? 3600,
    token_type: data.token_type ?? 'bearer',
    user: data.user,
  }
}

async function installSsoBypass(page) {
  const ssoOk = body => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  await page.route('**/private/sso/check-domain', async (route) => {
    await route.fulfill(ssoOk({ has_sso: false, enforce_sso: false }))
  })
  await page.route('**/private/sso/check-enforcement', async (route) => {
    await route.fulfill(ssoOk({ allowed: true }))
  })
}

async function login(page, baseURL) {
  await installSsoBypass(page)
  const session = await fetchPreprodSession()
  await page.goto(`${baseURL}/login/`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.evaluate(({ storageKey, sessionData }) => {
    localStorage.setItem(storageKey, JSON.stringify(sessionData))
  }, { storageKey: PREPROD_STORAGE_KEY, sessionData: session })
  await page.goto(`${baseURL}/apps`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForURL(/\/(apps|dashboard|onboarding|app)(\/|$)/, { timeout: 60000 })
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

async function dismissChrome(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const remind = page.getByRole('button', { name: /remind me later/i })
    if (await remind.count()) {
      await remind.click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(500)
      continue
    }
    break
  }
}

function channelLinkDialog(page) {
  return page.locator('div.shadow-xl').filter({ has: page.locator('#dialog-v2-content') }).last()
}

async function captureRolloutSection(page, baseURL, fileName, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(`${baseURL}/app/${APP_ID}/channel/${CHANNEL_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })
  await settle(page)
  await dismissChrome(page)

  const section = page.locator('section[aria-labelledby="rollout-settings-title"]')
  await section.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {})
  if (!(await section.count()))
    throw new Error(`Progressive rollout section not found for ${fileName}`)
  await section.scrollIntoViewIfNeeded()
  await section.screenshot({ path: path.join(OUT_DIR, fileName) })
}

async function captureBundleAssignDialog(page, baseURL, fileName) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${baseURL}/app/${APP_ID}/bundle/${BUNDLE_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })
  await settle(page)
  await dismissChrome(page)

  const setBundleLink = page.locator('#open-channel').first()
  await setBundleLink.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {})
  if (!(await setBundleLink.count()))
    throw new Error('Set bundle entry not found on bundle page')
  await setBundleLink.click({ force: true })
  await settle(page)

  const dialog = channelLinkDialog(page)
  if (!(await dialog.count()))
    throw new Error('Channel link dialog not found')

  const productionRow = dialog.locator('#dialog-v2-content div.cursor-pointer').filter({ hasText: /Channel id:\s*1\b/i }).first()
  if (!(await productionRow.count()))
    throw new Error('Production channel row not found in link dialog')
  await productionRow.click()
  await settle(page)

  const rolloutChoice = dialog.getByText(/auto \(recommended\)|rollout target|replace stable/i).first()
  if (!(await rolloutChoice.count()))
    throw new Error('Progressive rollout assign choices not visible in dialog')

  await dialog.screenshot({ path: path.join(OUT_DIR, fileName) })
}

async function removeAfterFiles() {
  await mkdir(OUT_DIR, { recursive: true })
  for (const file of await readdir(OUT_DIR)) {
    if (file.startsWith('after-local-') || file.startsWith('after-preprod-')) {
      await unlink(path.join(OUT_DIR, file))
    }
  }
}

async function main() {
  await removeAfterFiles()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(120000)

  console.log(`[capture] AFTER PR UI via ${AFTER_BASE} (serve:local + preprod Supabase auth)`)
  await login(page, AFTER_BASE)
  await dismissChrome(page)

  await captureRolloutSection(page, AFTER_BASE, 'after-local-desktop-rollout-section.png', { width: 1280, height: 900 })
  await captureRolloutSection(page, AFTER_BASE, 'after-local-mobile-rollout-section.png', { width: 375, height: 812 })
  await captureBundleAssignDialog(page, AFTER_BASE, 'after-local-bundle-assign-dialog.png')

  await browser.close()
  console.log('[capture] done ->', OUT_DIR)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
