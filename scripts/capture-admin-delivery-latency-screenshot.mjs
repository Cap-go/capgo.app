import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from '@playwright/test'

const baseUrl = process.env.SCREENSHOT_BASE_URL || 'http://127.0.0.1:5173'
const outputPath = resolve(process.cwd(), process.env.SCREENSHOT_OUTPUT || 'pr-assets/pr-3212-admin-delivery-latency-after.webp')
const adminUserId = 'c591b04e-cf29-4945-b9a0-776d0672061a'
const adminEmail = process.env.SCREENSHOT_ADMIN_EMAIL || 'admin@capgo.app'

function authStorageKey(origin) {
  const hostname = new URL(origin).hostname.split('.')[0]
  return `sb-${hostname}-auth-token`
}

function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.local-screenshot-signature`
}

function buildSession() {
  const now = Math.floor(Date.now() / 1000)
  const accessToken = fakeJwt({
    sub: adminUserId,
    role: 'authenticated',
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
    email: adminEmail,
  })

  return {
    access_token: accessToken,
    refresh_token: 'local-screenshot-refresh-token',
    expires_in: 3600,
    expires_at: now + 3600,
    token_type: 'bearer',
    user: {
      id: adminUserId,
      email: adminEmail,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { test_identifier: 'test_admin' },
      aud: 'authenticated',
      created_at: '2022-06-03T05:54:15.000Z',
      email_confirmed_at: '2022-06-03T05:54:15.000Z',
    },
  }
}

function buildDeliveryStatsPayload(days = 30) {
  const labels = []
  const end = new Date()
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(end)
    date.setUTCDate(end.getUTCDate() - i)
    labels.push(date.toISOString().slice(0, 10))
  }
  const p50_ms = labels.map((_, index) => 820 + index * 15)
  const p75_ms = labels.map((_, index) => 1280 + index * 20)
  const p95_ms = labels.map((_, index) => 2450 + index * 35)
  const p99_ms = labels.map((_, index) => 4100 + index * 48)
  const samples = labels.map((_, index) => 180 + index * 12)

  return {
    scope: 'platform',
    labels,
    period: {
      requested_days: days,
      actual_days: labels.length,
      start: `${labels[0]}T00:00:00.000Z`,
      end: `${labels[labels.length - 1]}T23:59:59.999Z`,
    },
    overview: {
      samples: samples.reduce((sum, value) => sum + value, 0),
      devices: 1284,
      p50_ms: p50_ms[p50_ms.length - 1] ?? null,
      p75_ms: p75_ms[p75_ms.length - 1] ?? null,
      p95_ms: p95_ms[p95_ms.length - 1] ?? null,
      p99_ms: p99_ms[p99_ms.length - 1] ?? null,
    },
    daily: {
      samples,
      p50_ms,
      p75_ms,
      p95_ms,
      p99_ms,
    },
  }
}

function buildAdminUserRow() {
  return {
    id: adminUserId,
    email: adminEmail,
    first_name: 'admin',
    last_name: 'Capgo',
    country: null,
    enable_notifications: true,
    opt_for_newsletters: true,
    image_url: null,
    created_at: '2022-06-03T05:54:15+00:00',
    discord_username: 'capgo-admin',
    github_username: 'capgo-admin',
  }
}

async function installAuthenticatedAdminSession(page, origin) {
  const session = buildSession()
  const storageKey = authStorageKey(origin)

  await page.addInitScript(({ key, value, userId }) => {
    localStorage.setItem(key, JSON.stringify(value))
    localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
  }, { key: storageKey, value: session, userId: adminUserId })

  await page.route('**/*', async (route) => {
    const url = route.request().url()
    const method = route.request().method()

    if (url.includes('/private/sso/check-enforcement')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allowed: true }),
      })
    }

    if (url.includes('/private/config')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    }

    if (url.includes('/auth/v1/token') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      })
    }

    if (url.includes('/auth/v1/user') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session.user),
      })
    }

    if (url.includes('/rest/v1/rpc/is_platform_admin')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: 'true',
      })
    }

    if (url.includes('/rest/v1/rpc/get_orgs_v7')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          gid: '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
          name: 'Admin org',
          role: 'owner',
          is_pending_invite: false,
          management_email: adminEmail,
          password_policy_config: null,
          stats_refresh_requested_at: null,
          stats_updated_at: null,
        }]),
      })
    }

    if (url.includes('/rest/v1/users')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildAdminUserRow()),
      })
    }

    if (url.includes('/rest/v1/plans')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    }

    if (url.includes('/private/update_delivery_stats') && method === 'POST') {
      let days = 30
      try {
        const body = route.request().postDataJSON()
        if (typeof body?.days === 'number')
          days = body.days
      }
      catch {}

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildDeliveryStatsPayload(days)),
      })
    }

    if (url.includes('/private/admin_stats') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          metric_category: 'global_stats_trend',
          data: [],
          period: { start: '2026-07-27', end: '2026-08-26' },
        }),
      })
    }

    return route.continue()
  })
}

async function dismissSupportPrompt(page) {
  const prompt = page.locator('[data-test="support-usernames-prompt"]')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await prompt.isVisible({ timeout: 2000 }).catch(() => false)))
      return
    await prompt.locator('[data-test="support-usernames-remind-later"]').click()
    await prompt.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
  }
}

async function main() {
  mkdirSync(dirname(outputPath), { recursive: true })

  const origin = new URL(baseUrl).origin
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })

  try {
    await installAuthenticatedAdminSession(page, origin)
    await page.goto(`${baseUrl}/admin/dashboard/updates`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await dismissSupportPrompt(page)

    if (page.url().includes('/login')) {
      throw new Error(`Auth guard redirected to login: ${page.url()}`)
    }

    const panel = page.locator('[data-testid="update-delivery-latency"]')
    await panel.waitFor({ state: 'visible', timeout: 120000 })
    await page.waitForFunction(() => {
      const panelEl = document.querySelector('[data-testid="update-delivery-latency"]')
      if (!panelEl)
        return false
      return !panelEl.querySelector('.animate-spin')
    }, { timeout: 120000 }).catch(() => {})
    await dismissSupportPrompt(page)
    await page.waitForTimeout(2500)

    const demoBadge = panel.locator('text=DEMO').or(panel.getByText(/^demo$/i))
    if (await demoBadge.count() > 0)
      throw new Error('Screenshot would include demo badge')

    const pngPath = outputPath.replace(/\.webp$/, '.png')
    await panel.screenshot({ path: pngPath, animations: 'disabled' })

    const cwebp = spawnSync('cwebp', ['-q', '90', pngPath, '-o', outputPath], { encoding: 'utf8' })
    if (cwebp.status !== 0) {
      const ffmpeg = spawnSync('ffmpeg', ['-y', '-i', pngPath, outputPath], { encoding: 'utf8', stdio: 'pipe' })
      if (ffmpeg.status !== 0)
        throw new Error(`webp conversion failed: ${cwebp.stderr || ffmpeg.stderr || 'no converter'}`)
    }

    console.log(`Saved screenshot: ${outputPath}`)
    console.log(`Captured from: ${page.url()}`)
  }
  finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
