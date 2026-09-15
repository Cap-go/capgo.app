import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import keys from '../configs.json' with { type: 'json' }

const baseUrl = process.env.CAPGO_URL || 'http://localhost:5173'
const email = process.env.CAPGO_EMAIL || 'test@capgo.app'
const password = process.env.CAPGO_PASSWORD || 'testtest'
const branch = process.env.BRANCH || 'preprod'
const outputPath = process.argv[2]
const mode = process.argv[3] || 'step2'

if (!outputPath) {
  console.error('Usage: bun scripts/capture-manage-2fa-screenshot.mjs <output.webp> [step2|rate-limit|captcha-error]')
  process.exit(1)
}

const supabaseUrl = keys.supa_url[branch] || keys.supa_url.preprod
const supabaseAnon = keys.supa_anon[branch] || keys.supa_anon.preprod
const supabaseId = supabaseUrl.split('//')[1].split('.')[0].split(':')[0]
const storageKey = `sb-${supabaseId}-auth-token`

const i18n = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const rateLimitSeconds = 54
const rateLimitError = i18n['email-otp-rate-limit-wait'].replace('{seconds}', String(rateLimitSeconds))
const rateLimitCountdown = i18n['email-otp-rate-limit-countdown'].replace('{seconds}', String(rateLimitSeconds))
const rateLimitButton = i18n['email-otp-send-wait'].replace('{seconds}', String(rateLimitSeconds))
const captchaFail = i18n['captcha-fail']
const sendCodeLabel = i18n['email-otp-send-code']

await mkdir(outputPath.split('/').slice(0, -1).join('/') || '.', { recursive: true })

const supabase = createClient(supabaseUrl, supabaseAnon)
const { data, error } = await supabase.auth.signInWithPassword({ email, password })
if (error || !data.session)
  throw new Error(error?.message || 'Login failed')

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

await context.addInitScript((captureMode) => {
  let autoCompleteCount = 0
  window.turnstile = {
    render(_element, options) {
      if (autoCompleteCount === 0) {
        autoCompleteCount++
        queueMicrotask(() => options.callback?.('screenshot-turnstile-token'))
      }
      return 'screenshot-turnstile-widget'
    },
    reset() {},
    remove() {},
  }
}, mode)

const page = await context.newPage()

if (mode === 'rate-limit' || mode === 'captcha-error') {
  await page.route('**/auth/v1/otp**', async (route) => {
    if (mode === 'rate-limit') {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'over_email_send_rate_limit',
          message: `For security purposes, you can only request this after ${rateLimitSeconds} seconds.`,
        }),
      })
      return
    }

    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'captcha_failed',
        message: 'captcha protection: request disallowed (no captcha_token found)',
      }),
    })
  })
}

await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate(({ storageKey, session }) => {
  localStorage.setItem(storageKey, JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  }))
}, { storageKey, session: data.session })

await page.goto(`${baseUrl}/settings/account/manage-2fa`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('h2', { timeout: 60000 })

if (mode === 'step2') {
  await page.getByRole('button', { name: sendCodeLabel }).waitFor({ timeout: 30000 })
}
else {
  await page.getByRole('button', { name: sendCodeLabel }).click()
}

if (mode === 'rate-limit') {
  await page.getByRole('alert').filter({ hasText: rateLimitError }).waitFor({ timeout: 15000 })
  await page.getByRole('status').filter({ hasText: rateLimitCountdown }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: rateLimitButton }).waitFor({ timeout: 15000 })
}
else if (mode === 'captcha-error') {
  await page.getByText(captchaFail).first().waitFor({ timeout: 15000 })
  await page.locator('.max-w-lg.mx-auto h4').filter({ hasText: i18n['2fa-step-captcha'] }).waitFor({ timeout: 15000 })
}
else if (mode === 'step2') {
  await page.getByRole('button', { name: sendCodeLabel }).waitFor({ timeout: 15000 })
}

await page.waitForTimeout(500)

const tempPng = `${outputPath}.tmp.png`
if (mode === 'captcha-error')
  await page.screenshot({ path: tempPng, type: 'png', fullPage: false })
else
  await page.locator('.max-w-lg.mx-auto').first().screenshot({ path: tempPng, type: 'png' })
const ffmpeg = spawnSync('ffmpeg', ['-y', '-i', tempPng, outputPath], { stdio: 'pipe' })
await unlink(tempPng).catch(() => {})
if (ffmpeg.status !== 0)
  throw new Error(`ffmpeg failed: ${ffmpeg.stderr?.toString() || ffmpeg.status}`)

console.log(`Saved ${outputPath}`)
await browser.close()
