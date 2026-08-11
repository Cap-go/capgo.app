import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173/'
const outDir = '/opt/cursor/artifacts/screenshots'

import { createClient } from '@supabase/supabase-js'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173/'
const outDir = '/opt/cursor/artifacts/screenshots'
const supabaseUrl = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const supabaseAnon = process.env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

async function login(page: import('@playwright/test').Page) {
  await page.goto(`${baseUrl}login?to=/app/com.demo.app`)
  await page.fill('[data-test="email"]', 'test@capgo.app')
  await page.click('[data-test="continue"]')
  await page.waitForSelector('[data-test="password"]')
  await page.fill('[data-test="password"]', 'testtest')
  const submit = page.locator('[data-test="submit"]')
  if (await submit.isEnabled())
    await submit.click()
  else
    await page.locator('form').first().evaluate((el: HTMLFormElement) => el.requestSubmit())
  await page.waitForURL(/\/(apps|dashboard|app)(\/|$)/, { timeout: 45000 })
}

async function ensureLocalAuth() {
  const supabase = createClient(supabaseUrl, supabaseAnon, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  const { error } = await supabase.auth.signInWithPassword({
    email: 'test@capgo.app',
    password: 'testtest',
  })
  if (error)
    throw new Error(`Local auth failed: ${error.message}`)
}
  await page.goto(`${baseUrl}login?to=/app/com.demo.app`)
  await page.fill('[data-test="email"]', 'test@capgo.app')
  await page.click('[data-test="continue"]')
  await page.waitForSelector('[data-test="password"]')
  await page.fill('[data-test="password"]', 'testtest')
  const submit = page.locator('[data-test="submit"]')
  if (await submit.isEnabled())
    await submit.click()
  else
    await page.locator('form').first().evaluate((el: HTMLFormElement) => el.requestSubmit())
  await page.waitForURL(/\/(apps|dashboard|app)(\/|$)/, { timeout: 45000 })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  if (!process.env.SKIP_LOCAL_AUTH)
    await ensureLocalAuth().catch(() => undefined)
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  try {
    await login(page)
    await page.goto(`${baseUrl}app/com.demo.app`)
    await page.waitForLoadState('networkidle')
    const panel = page.locator('[data-testid="bundle-install-stats"]')
    await panel.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1500)
    await panel.screenshot({ path: join(outDir, 'bundle-install-stats-app.png') })
    await page.screenshot({ path: join(outDir, 'bundle-install-stats-app-full.png'), fullPage: true })

    await page.goto(`${baseUrl}app/com.demo.app/channels`)
    await page.waitForLoadState('networkidle')
    const statsLink = page.locator('a[href*="/statistics"]').first()
    if (await statsLink.count() > 0) {
      await statsLink.click()
      await page.waitForLoadState('networkidle')
      const channelPanel = page.locator('[data-testid="bundle-install-stats"]')
      await channelPanel.scrollIntoViewIfNeeded()
      await page.waitForTimeout(1500)
      await channelPanel.screenshot({ path: join(outDir, 'bundle-install-stats-channel.png') })
    }

    console.log('Screenshots saved to', outDir)
  }
  catch (error) {
    await page.screenshot({ path: join(outDir, 'bundle-install-stats-failure.png'), fullPage: true })
    console.error(error)
    process.exitCode = 1
  }
  finally {
    await browser.close()
  }
}

await main()
