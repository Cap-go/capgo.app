// Real-browser load timings for two console builds (before/after) against the same local API.
//
// 1. Start the local stack and seed it: bun run supabase:start && bun run supabase:db:reset,
//    then bun run supabase:functions:serve.
// 2. Build both versions against it, e.g.
//    ENV=local API_DOMAIN=127.0.0.1:<api port>/functions/v1 bunx vite build --outDir /tmp/perf-before
// 3. Serve each build with scripts/perf/serve-h2.mjs (ports 5181 and 5182).
// 4. bun scripts/perf/runtime-bench.ts <runs> <out.json>
//
// Each scenario runs in a fresh browser context (empty HTTP cache) and reports the median.
import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

const runs = Number(process.argv[2] ?? 5)
const out = process.argv[3] ?? path.join(tmpdir(), 'capgo-runtime-bench.json')
const builds = {
  before: process.env.PERF_BEFORE_URL ?? 'https://localhost:5181',
  after: process.env.PERF_AFTER_URL ?? 'https://localhost:5182',
} as const

const profiles = {
  // Chrome DevTools "Slow 4G" + 4x CPU slowdown on a phone viewport: a weak mobile connection.
  'mobile (slow 4G, 4x CPU)': { viewport: { width: 390, height: 844 }, isMobile: true, latency: 562.5, down: 1474.56 * 1024 / 8, up: 675 * 1024 / 8, cpu: 4 },
  // Typical desktop broadband.
  'desktop (cable)': { viewport: { width: 1440, height: 900 }, isMobile: false, latency: 40, down: 10 * 1024 * 1024 / 8, up: 5 * 1024 * 1024 / 8, cpu: 1 },
} as const
type Profile = (typeof profiles)[keyof typeof profiles]

async function throttle(page: Page, profile: Profile) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
  return cdp
}

function trackBytes(cdp: CDPSession) {
  const state = { bytes: 0, requests: 0, api: 0 }
  const urls = new Map<string, string>()
  cdp.on('Network.requestWillBeSent', (event: any) => urls.set(event.requestId, event.request.url))
  cdp.on('Network.loadingFinished', (event: any) => {
    state.bytes += event.encodedDataLength
    state.requests++
    if ((urls.get(event.requestId) ?? '').includes('/functions/v1/'))
      state.api++
  })
  return state
}

async function newContext(browser: Browser, profile: Profile, storageState?: string) {
  return browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, storageState, serviceWorkers: 'block', ignoreHTTPSErrors: true })
}

async function login(browser: Browser, base: string, profile: Profile) {
  const context = await newContext(browser, profile)
  const page = await context.newPage()
  await page.goto(`${base}/login`)
  await page.fill('[data-test="email"]', 'test@capgo.app')
  const password = page.locator('[data-test="password"]')
  if (!(await password.isVisible()))
    await page.locator('[data-test="submit"]').click()
  await password.waitFor({ state: 'visible' })
  await password.fill('testtest')
  await page.locator('[data-test="submit"]').click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60000 })
  await page.locator('[data-test="dashboard-shell"]').first().waitFor({ timeout: 60000 })
  // Same key as src/services/supportUsernamesPrompt.ts: keep the support prompt from covering the page.
  await page.evaluate(() => localStorage.setItem('capgo.supportUsernames.lastShown.6aa76066-55ef-4238-ade6-0b32334a4097', new Date().toISOString()))
  const statePath = path.join(tmpdir(), `capgo-perf-state-${new URL(base).port}-${profile.isMobile ? 'm' : 'd'}.json`)
  await context.storageState({ path: statePath })
  await context.close()
  return statePath
}

async function paintMetrics(page: Page) {
  return page.evaluate(() => new Promise<{ fcp: number, lcp: number }>((resolve) => {
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0
    let lcp = 0
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        lcp = Math.max(lcp, entry.startTime)
    }).observe({ type: 'largest-contentful-paint', buffered: true })
    setTimeout(() => resolve({ fcp, lcp }), 50)
  }))
}

async function timed(context: BrowserContext, profile: Profile, url: string, ready: (page: Page) => Promise<unknown>) {
  const page = await context.newPage()
  const cdp = await throttle(page, profile)
  const bytes = trackBytes(cdp)
  const start = Date.now()
  await page.goto(url, { waitUntil: 'commit' })
  await ready(page)
  const elapsed = Date.now() - start
  const paint = await paintMetrics(page)
  return { page, cdp, bytes, elapsed, paint }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const browser = await chromium.launch()
  const results: Record<string, Record<string, Record<string, number[]>>> = {}
  const record = (profile: string, scenario: string, build: string, metric: string, value: number) => {
    results[profile] ??= {}
    results[profile][`${scenario} | ${metric}`] ??= {}
    const bucket = results[profile][`${scenario} | ${metric}`] as any
    bucket[build] ??= []
    bucket[build].push(value)
  }

  for (const [profileName, profile] of Object.entries(profiles)) {
    const states: Record<string, string> = {}
    for (const [build, base] of Object.entries(builds))
      states[build] = await login(browser, base, profile)

    for (let run = 0; run < runs; run++) {
      // Alternate the order so drift on the machine does not favour one build.
      const order = run % 2 === 0 ? Object.entries(builds) : Object.entries(builds).reverse()
      for (const [build, base] of order) {
        // 1. First visit to the login page, empty cache.
        {
          const context = await newContext(browser, profile)
          const r = await timed(context, profile, `${base}/login`, async (page) => {
            await page.locator('[data-test="email"]').waitFor({ state: 'visible', timeout: 120000 })
            await page.locator('#app-loader').waitFor({ state: 'hidden', timeout: 120000 })
          })
          record(profileName, 'Login page, first visit', build, 'ready ms', r.elapsed)
          record(profileName, 'Login page, first visit', build, 'LCP ms', r.paint.lcp)
          record(profileName, 'Login page, first visit', build, 'KB transferred', r.bytes.bytes / 1024)
          await context.close()
        }
        // 2. Signed-in user opens the dashboard, empty cache.
        {
          const context = await newContext(browser, profile, states[build])
          const r = await timed(context, profile, `${base}/apps`, page => page.locator('#custom_table').getByText('Demo app').filter({ visible: true }).first().waitFor({ timeout: 120000 }))
          record(profileName, 'Dashboard (/apps), cold', build, 'ready ms', r.elapsed)
          record(profileName, 'Dashboard (/apps), cold', build, 'KB transferred', r.bytes.bytes / 1024)
          record(profileName, 'Dashboard (/apps), cold', build, 'API requests', r.bytes.api)

          // 3. In-app navigation: open the app overview from the list.
          const navStart = Date.now()
          const before = r.bytes.api
          await r.page.locator('#custom_table').getByText('Demo app').filter({ visible: true }).first().click()
          await r.page.locator('[data-testid="overview-kpis"]').waitFor({ timeout: 120000 })
          record(profileName, 'Open app overview from list', build, 'ready ms', Date.now() - navStart)
          record(profileName, 'Open app overview from list', build, 'API requests', r.bytes.api - before)

          // 4. Back to the list, then forward again (warm route chunks).
          const backStart = Date.now()
          await r.page.goBack()
          await r.page.locator('#custom_table').getByText('Demo app').filter({ visible: true }).first().waitFor({ timeout: 120000 })
          record(profileName, 'Back to app list', build, 'ready ms', Date.now() - backStart)
          await context.close()
        }
        // 5. Signed-in user opens an app overview URL directly, empty cache.
        {
          const context = await newContext(browser, profile, states[build])
          const r = await timed(context, profile, `${base}/app/com.demo.app`, page => page.locator('[data-testid="overview-kpis"]').waitFor({ timeout: 120000 }))
          record(profileName, 'App overview (/app/:id), cold', build, 'ready ms', r.elapsed)
          record(profileName, 'App overview (/app/:id), cold', build, 'KB transferred', r.bytes.bytes / 1024)
          await context.close()
        }
        console.log(`${profileName} run ${run + 1}/${runs} ${build} done`)
        writeSummary(results)
      }
    }
  }
  await browser.close()
  writeSummary(results)
}

function writeSummary(results: Record<string, Record<string, Record<string, number[]>>>) {
  const summary: Record<string, Record<string, { before: number, after: number, change: string }>> = {}
  for (const [profileName, metrics] of Object.entries(results)) {
    summary[profileName] = {}
    for (const [metric, values] of Object.entries(metrics)) {
      if (!(values as any).before || !(values as any).after)
        continue
      const before = median((values as any).before)
      const after = median((values as any).after)
      summary[profileName][metric] = { before: Math.round(before), after: Math.round(after), change: before ? `${(((after - before) / before) * 100).toFixed(1)}%` : 'n/a' }
    }
  }
  writeFileSync(out, JSON.stringify({ runs, results, summary }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
