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

// Playwright's waitFor polls with a backoff (up to 1 s between checks), which rounds timings
// to its poll schedule. Record the exact moment each target shows up from inside the page.
// Plain JavaScript string: a serialized TS function can reference helpers injected by the runner.
const markScript = `
(() => {
  const marks = {}
  window.__marks = marks
  window.__resetMarks = () => { for (const key of Object.keys(marks)) delete marks[key] }
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
  const checks = {
    login: () => visible(document.querySelector('[data-test="email"]')) && !visible(document.querySelector('#app-loader')),
    appList: () => [...document.querySelectorAll('#custom_table *')].some(element => element.textContent.trim() === 'Demo app' && visible(element)),
    overview: () => visible(document.querySelector('[data-testid="overview-kpis"]')),
  }
  const check = () => {
    for (const name of Object.keys(checks)) {
      if (marks[name] === undefined && checks[name]())
        marks[name] = performance.now()
    }
  }
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  const frame = () => { check(); requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
})()
`

async function mark(page: Page, name: string) {
  const expression = `window.__marks && window.__marks[${JSON.stringify(name)}]`
  await page.waitForFunction(`${expression} !== undefined`, undefined, { timeout: 120000 })
  return page.evaluate(expression) as Promise<number>
}

async function newContext(browser: Browser, profile: Profile, storageState?: string) {
  const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, storageState, serviceWorkers: 'block', ignoreHTTPSErrors: true })
  await context.addInitScript({ content: markScript })
  return context
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

async function timed(context: BrowserContext, profile: Profile, url: string, markName: string) {
  const page = await context.newPage()
  const cdp = await throttle(page, profile)
  const bytes = trackBytes(cdp)
  await page.goto(url, { waitUntil: 'commit' })
  // performance.now() counts from the navigation start of this document.
  const elapsed = await mark(page, markName)
  const paint = await paintMetrics(page)
  return { page, cdp, bytes, elapsed, paint }
}

async function timedAction(page: Page, markName: string, action: () => Promise<unknown>) {
  const start = await page.evaluate('window.__resetMarks(), performance.now()') as number
  await action()
  return (await mark(page, markName)) - start
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
          const r = await timed(context, profile, `${base}/login`, 'login')
          record(profileName, 'Login page, first visit', build, 'ready ms', r.elapsed)
          record(profileName, 'Login page, first visit', build, 'LCP ms', r.paint.lcp)
          record(profileName, 'Login page, first visit', build, 'KB transferred', r.bytes.bytes / 1024)
          await context.close()
        }
        // 2. Signed-in user opens the dashboard, empty cache.
        {
          const context = await newContext(browser, profile, states[build])
          const r = await timed(context, profile, `${base}/apps`, 'appList')
          record(profileName, 'Dashboard (/apps), cold', build, 'ready ms', r.elapsed)
          record(profileName, 'Dashboard (/apps), cold', build, 'KB transferred', r.bytes.bytes / 1024)
          record(profileName, 'Dashboard (/apps), cold', build, 'API requests', r.bytes.api)

          // 3. In-app navigation: open the app overview from the list.
          const before = r.bytes.api
          const overviewMs = await timedAction(r.page, 'overview', () => r.page.locator('#custom_table').getByText('Demo app').filter({ visible: true }).first().click())
          record(profileName, 'Open app overview from list', build, 'ready ms', overviewMs)
          record(profileName, 'Open app overview from list', build, 'API requests', r.bytes.api - before)

          // 4. Back to the list (route chunks already loaded).
          const backMs = await timedAction(r.page, 'appList', () => r.page.goBack())
          record(profileName, 'Back to app list', build, 'ready ms', backMs)
          await context.close()
        }
        // 5. Signed-in user opens an app overview URL directly, empty cache.
        {
          const context = await newContext(browser, profile, states[build])
          const r = await timed(context, profile, `${base}/app/com.demo.app`, 'overview')
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
