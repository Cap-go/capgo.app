import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const baseUrl = process.env.CAPGO_URL || 'http://localhost:5173'
const outputDir = process.env.OUTPUT_DIR || 'docs/screenshots/security-updates-ui'
const phase = process.env.PHASE || 'after'

await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
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
const viewports = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
}

async function login(page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' })
  await page.locator('input[type="email"]').fill('test@capgo.app')
  await page.locator('input[type="password"]').fill('testtest')
  await page.getByRole('button', { name: /log in|sign in/i }).click()
  await page.waitForURL(/\/(apps|dashboard|onboarding)/, { timeout: 120_000 })
}

async function capture(name, path, viewport) {
  const page = await context.newPage({ viewport })
  await login(page)
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${outputDir}/${phase}-${name}.png`, type: 'png', fullPage: true })
  await page.close()
}

for (const [size, viewport] of Object.entries(viewports)) {
  await capture(`${size}-account-notifications`, '/settings/account/notifications', viewport)
  if (phase === 'before') {
    await capture(`${size}-app-observe-before`, '/app/com.demo.app/observe/errors', viewport)
  }
  else {
    await capture(`${size}-app-security-updates`, '/app/com.demo.app/observe/security', viewport)
  }
}

await browser.close()
