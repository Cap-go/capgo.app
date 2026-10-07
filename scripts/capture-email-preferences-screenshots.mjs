import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdir, unlink } from 'node:fs/promises'

const baseUrl = process.env.CAPGO_URL || 'http://localhost:5173'
const outputDir = process.env.OUTPUT_DIR || 'docs/screenshots'
const visitorHex = 'a1b2c3d4e5f6478990aabbccddeeff00'

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

await context.addInitScript(() => {
  window.turnstile = {
    render(_element, options) {
      queueMicrotask(() => options.callback?.('screenshot-turnstile-token'))
      return 'screenshot-turnstile-widget'
    },
    reset() {},
    remove() {},
  }
})

async function capture(name, path, setup) {
  const page = await context.newPage()
  await setup(page)
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const tempPng = `${outputDir}/${name}.tmp.png`
  await page.screenshot({ path: tempPng, type: 'png', fullPage: true })
  const ffmpeg = spawnSync('ffmpeg', ['-y', '-i', tempPng, `${outputDir}/${name}`], { stdio: 'pipe' })
  await unlink(tempPng).catch(() => {})
  if (ffmpeg.status !== 0)
    throw new Error(`ffmpeg failed for ${name}: ${ffmpeg.stderr?.toString() || ffmpeg.status}`)
  await page.close()
}

await capture('email-preferences-32hex-uuid-param.webp', `/email-preferences?uuid=${visitorHex}`, async (page) => {
  await page.route('**/private/email_preferences**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', email: 'demo@example.com' }),
      })
      return
    }
    await route.continue()
  })
})

await capture('email-preferences-32hex-email-param.webp', `/email-preferences?email=${visitorHex}`, async (page) => {
  await page.route('**/private/email_preferences**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', email: 'demo@example.com' }),
      })
      return
    }
    await route.continue()
  })
})

await capture('email-preferences-load-error.webp', `/email-preferences?uuid=${visitorHex}`, async (page) => {
  await page.route('**/private/email_preferences**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'email_preferences_not_found', status: 'Error' }),
      })
      return
    }
    await route.continue()
  })
})

await capture('email-preferences-save-error.webp', `/email-preferences?email=user@example.com`, async (page) => {
  await page.route('**/private/email_preferences**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'email_preferences_not_found', status: 'Error' }),
      })
      return
    }
    await route.continue()
  })
})

const savePage = await context.newPage()
await savePage.route('**/private/email_preferences**', async (route) => {
  if (route.request().method() === 'POST') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    })
    return
  }
  await route.continue()
})
await savePage.goto(`${baseUrl}/email-preferences?email=user@example.com`, { waitUntil: 'networkidle' })
await savePage.getByRole('button', { name: /save preferences/i }).click()
await savePage.waitForTimeout(500)
const successPng = `${outputDir}/email-preferences-save-success.webp.tmp.png`
await savePage.screenshot({ path: successPng, type: 'png', fullPage: true })
const successFfmpeg = spawnSync('ffmpeg', ['-y', '-i', successPng, `${outputDir}/email-preferences-save-success.webp`], { stdio: 'pipe' })
await unlink(successPng).catch(() => {})
if (successFfmpeg.status !== 0)
  throw new Error(`ffmpeg failed for save success: ${successFfmpeg.stderr?.toString() || successFfmpeg.status}`)
await savePage.close()

await browser.close()
console.log(`Saved email preference screenshots to ${outputDir}`)
