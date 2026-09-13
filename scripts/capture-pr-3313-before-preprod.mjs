import { chromium } from '@playwright/test'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'

const EMAIL = process.env.CAPGO_SCREENSHOT_EMAIL ?? 'test@capgo.app'
const PASSWORD = process.env.CAPGO_SCREENSHOT_PASSWORD ?? 'testtest'
const OUT_DIR = path.resolve('docs/pr-screenshots/3313')
const BASE_URL = 'https://console.preprod.capgo.app'
const APP_ID = 'com.demo.app'
const CHANNEL_ID = process.env.CAPGO_SCREENSHOT_CHANNEL_ID ?? '1'
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

async function login(page) {
  const session = await fetchPreprodSession()
  await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.evaluate(({ storageKey, sessionData }) => {
    localStorage.setItem(storageKey, JSON.stringify(sessionData))
  }, { storageKey: PREPROD_STORAGE_KEY, sessionData: session })
  await page.goto(`${BASE_URL}/apps`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForURL(/\/(apps|dashboard|onboarding|app)(\/|$)/, { timeout: 60000 })
}

async function dismissChrome(page) {
  const remind = page.getByRole('button', { name: /remind me later/i })
  if (await remind.count())
    await remind.click({ timeout: 3000 }).catch(() => {})
}

async function captureChannelInformation(page, fileName, viewport) {
  await page.setViewportSize(viewport)
  await page.goto(`${BASE_URL}/app/${APP_ID}/channel/${CHANNEL_ID}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await dismissChrome(page)

  const bodyText = await page.locator('body').innerText()
  if (/channel not found/i.test(bodyText))
    throw new Error(`Channel ${CHANNEL_ID} not found on ${BASE_URL}`)
  if (/progressive rollout/i.test(bodyText))
    throw new Error('Deployed preprod unexpectedly shows progressive rollout UI')

  const panel = page.locator('dl').first()
  await panel.scrollIntoViewIfNeeded()
  await panel.screenshot({ path: path.join(OUT_DIR, fileName) })
}

async function clearOutDir() {
  await mkdir(OUT_DIR, { recursive: true })
  for (const file of await readdir(OUT_DIR)) {
    if (file.endsWith('.png'))
      await unlink(path.join(OUT_DIR, file))
  }
}

async function main() {
  await clearOutDir()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(120000)

  console.log(`[capture] BEFORE hosted preprod: ${BASE_URL}`)
  await login(page)
  await captureChannelInformation(page, 'before-preprod-desktop-channel-information.png', { width: 1280, height: 900 })
  await captureChannelInformation(page, 'before-preprod-mobile-channel-information.png', { width: 375, height: 812 })

  await browser.close()
  console.log('[capture] done ->', OUT_DIR)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
