import { chromium, devices } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const baseUrl = process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:5173'
const outDir = process.argv[2]
if (!outDir)
  throw new Error('usage: node scripts/capture-pr-login-screenshots.mjs <output-dir>')

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch()

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', devices['iPhone 13'].viewport]]) {
  const context = await browser.newContext({ viewport })

  {
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.turnstile = {
        render(_el, opts) {
          queueMicrotask(() => opts.callback?.('screenshot-captcha-token'))
          return 'widget-1'
        },
        reset() {},
        remove() {},
      }
    })
    await page.goto(`${baseUrl}/login/`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(outDir, `login-normal-${label}.png`), fullPage: true })
    await page.close()
  }

  {
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.turnstile = {
        render() {
          return 'widget-1'
        },
        reset() {},
        remove() {},
      }
    })
    await page.goto(`${baseUrl}/login/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-test="login-captcha-verifying"]', { timeout: 10_000 })
    await page.screenshot({ path: path.join(outDir, `login-verifying-${label}.png`), fullPage: true })
    await page.close()
  }

  {
    const page = await context.newPage()
    await page.route('**/challenges.cloudflare.com/**', route => route.abort())
    await page.goto(`${baseUrl}/login/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-test="login-captcha-fallback"]', { timeout: 35_000 })
    await page.screenshot({ path: path.join(outDir, `login-fallback-${label}.png`), fullPage: true })
    await page.close()
  }

  await context.close()
}

await browser.close()
