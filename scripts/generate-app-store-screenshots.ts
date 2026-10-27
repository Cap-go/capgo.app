import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import type { Browser, Page } from '@playwright/test'
import { chromium } from '@playwright/test'
import { createClient } from './db-client.ts'
import { Client } from 'pg'
import { installMocks, maskIdentities } from './marketing-screenshots/mocks'
import { getPlaywrightStripeApiBaseUrl, getStripeEmulatorPort } from './playwright-stripe'
import { getSupabaseWorktreeConfig } from './supabase-worktree-config'

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams
  name: string
}

interface SupabaseStatus {
  API_URL?: string
  ANON_KEY?: string
  PUBLISHABLE_KEY?: string
  DB_URL?: string
}

interface ScreenshotDevice {
  slug: string
  // App Store Connect matches screenshots by pixel size, the prefix only keeps files readable
  filePrefix: string
  cssWidth: number
  cssHeight: number
  scale: number
  mobile: boolean
  // Defaults to the fastlane deliver folder; set for sizes deliver can't upload yet
  outputDir?: string
  // Google Play screenshot folders that reuse this capture
  androidDirs: string[]
}

interface CreativeAsset {
  fileName: string
  cssWidth: number
  cssHeight: number
  scale: number
  layout: 'header' | 'search' | 'feature'
}

const repoRoot = process.cwd()
const outputRoot = resolve(repoRoot, 'fastlane/screenshots/en-US')
const androidOutputRoot = resolve(repoRoot, 'fastlane/metadata/android/en-US/images')
const androidScreenshotDirs = ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots']
const appStoreAssetsRoot = resolve(repoRoot, 'fastlane/app-store-assets')
const rawRoot = resolve(repoRoot, '.context/app-store-screenshots/raw')
const composeRoot = resolve(repoRoot, '.context/app-store-screenshots/compose')
const brandMarkPath = resolve(repoRoot, 'assets/brand/capgo-mark-white.svg')
const logRoot = resolve(repoRoot, '.context/app-store-screenshots/logs')
const screenshotBaseUrl = process.env.APP_STORE_SCREENSHOT_BASE_URL || 'http://127.0.0.1:5173'
const supabaseConfig = getSupabaseWorktreeConfig(repoRoot)
const localSupabaseUrl = `http://127.0.0.1:${supabaseConfig.ports.api}`
const localApiDomain = `127.0.0.1:${supabaseConfig.ports.api}/functions/v1`
const stripePort = getStripeEmulatorPort(process.env)
const stripeApiBaseUrl = getPlaywrightStripeApiBaseUrl(process.env)
const managedProcesses: ManagedProcess[] = []
const isWindows = process.platform === 'win32'

const devices: ScreenshotDevice[] = [
  {
    slug: 'iphone-6-9',
    filePrefix: 'iPhone 6.9in',
    cssWidth: 440,
    cssHeight: 956,
    scale: 3,
    mobile: true,
    androidDirs: [],
  },
  {
    slug: 'iphone-6-5',
    filePrefix: 'iPhone 6.5in',
    cssWidth: 428,
    cssHeight: 926,
    scale: 3,
    mobile: true,
    androidDirs: [],
  },
  {
    slug: 'iphone-6-3',
    filePrefix: 'iPhone 6.3in',
    cssWidth: 402,
    cssHeight: 874,
    scale: 3,
    mobile: true,
    androidDirs: [],
  },
  {
    slug: 'iphone-5-5',
    filePrefix: 'iPhone 5.5in',
    cssWidth: 414,
    cssHeight: 736,
    scale: 3,
    mobile: true,
    androidDirs: ['phoneScreenshots'],
  },
  {
    slug: 'iphone-duo-outer',
    filePrefix: 'iPhone Duo outer',
    cssWidth: 466,
    cssHeight: 678,
    scale: 3,
    mobile: true,
    outputDir: resolve(appStoreAssetsRoot, 'iphone-duo'),
    androidDirs: [],
  },
  {
    slug: 'iphone-duo-inner',
    filePrefix: 'iPhone Duo inner',
    cssWidth: 669,
    cssHeight: 951,
    scale: 3,
    mobile: true,
    outputDir: resolve(appStoreAssetsRoot, 'iphone-duo'),
    androidDirs: [],
  },
  {
    slug: 'ipad-13',
    filePrefix: 'iPad 13in',
    cssWidth: 1032,
    cssHeight: 1376,
    scale: 2,
    mobile: false,
    androidDirs: ['sevenInchScreenshots', 'tenInchScreenshots'],
  },
]

// App Store creative assets (product page header, search results) and the Google Play feature graphic
const creativeAssets: CreativeAsset[] = [
  { fileName: 'product-page-header-21x9.png', cssWidth: 1920, cssHeight: 823, scale: 2, layout: 'header' },
  { fileName: 'product-page-header-16x9.png', cssWidth: 2622, cssHeight: 1475, scale: 2, layout: 'header' },
  { fileName: 'search-result-3x2.png', cssWidth: 1920, cssHeight: 1280, scale: 2, layout: 'search' },
  { fileName: 'search-result-16x9.png', cssWidth: 2622, cssHeight: 1475, scale: 2, layout: 'search' },
]
const featureGraphic: CreativeAsset = { fileName: 'featureGraphic.png', cssWidth: 1024, cssHeight: 500, scale: 1, layout: 'feature' }

// Demo data comes from scripts/marketing-screenshots (seed.sql + mocked analytics), so every screen shows a live-looking app
// playOnly screens show other platforms (Android device rows, platform tags), which App Review rejects (guideline 2.3.10)
const screens: { slug: string, path: string, title: string, subtitle: string, playOnly?: boolean, prepare?: (page: Page) => Promise<void> }[] = [
  { slug: 'live-release', path: '/app/com.demo.app?days=7', title: 'Watch each release go live', subtitle: 'Adoption, installs, and failures in real time' },
  {
    slug: 'rollout',
    path: '/app/com.demo.app/channel/1',
    title: 'Roll out safely',
    subtitle: 'Start small and pause automatically on errors',
    playOnly: true,
    prepare: async (page) => {
      await page.getByText(/of devices receive/).first().evaluate((el: Element) => el.closest('div')?.parentElement?.scrollIntoView({ block: 'center' })).catch(() => {})
      await page.waitForTimeout(600)
    },
  },
  { slug: 'update-health', path: '/app/com.demo.app/observe/errors?days=7', title: 'Catch failed updates fast', subtitle: 'See which devices failed and why' },
  { slug: 'channels', path: '/app/com.demo.app/channels', title: 'Ship to beta, then production', subtitle: 'Channels for every audience' },
  { slug: 'devices', path: '/app/com.demo.app/devices', title: 'Know what each device runs', subtitle: 'Find any user\'s version in seconds', playOnly: true },
  { slug: 'preview-qr', path: '/app/com.demo.app/channel/1/preview?appStoreQr=1', title: 'Preview any build with a scan', subtitle: 'Share bundles with your team by QR' },
  { slug: 'builds', path: '/app/com.demo.app/builds', title: 'Native builds in the cloud', subtitle: 'Signed, uploaded, and tracked for you' },
]

const hideChromeCss = `
  #__vue-devtools-container__, [id^="vue-devtools"], vite-error-overlay { display: none !important; }
  *, *::before, *::after { caret-color: transparent !important; }
  [data-sonner-toaster], [data-test="getting-started-nav"], [data-test="section-intro"] { display: none !important; }
`

// Framed layout: headline on top, the app capture inside a bezel that bleeds off the bottom edge
const frameWidthRatio = 0.84
const frameTopRatio = 0.27
const frameBleedRatio = 0.04
const bezelRatio = 0.016

function frameMetrics(device: ScreenshotDevice) {
  const frameWidth = Math.round(device.cssWidth * frameWidthRatio)
  const bezel = Math.max(4, Math.round(device.cssWidth * bezelRatio))
  const frameTop = Math.round(device.cssHeight * frameTopRatio)
  const frameHeight = device.cssHeight - frameTop + Math.round(device.cssHeight * frameBleedRatio)
  return {
    frameWidth,
    frameTop,
    bezel,
    rawWidth: frameWidth - bezel * 2,
    rawHeight: frameHeight - bezel * 2,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function isHttpReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url)
    return response.status < 500
  }
  catch {
    return false
  }
}

function isTcpReady(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolveReady) => {
    const socket = net.connect({ port, host })
    socket.setTimeout(750)
    socket.once('connect', () => {
      socket.destroy()
      resolveReady(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolveReady(false)
    })
    socket.once('error', () => {
      socket.destroy()
      resolveReady(false)
    })
  })
}

async function waitForHttp(url: string, timeoutMs: number, label: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHttpReady(url))
      return
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`)
}

async function waitForTcp(port: number, timeoutMs: number, label: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isTcpReady(port))
      return
    await sleep(500)
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`)
}

async function waitForFile(path: string, timeoutMs: number, label: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path))
      return
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${label} at ${path}`)
}

function startProcess(name: string, args: string[], env: NodeJS.ProcessEnv = {}): ManagedProcess {
  mkdirSync(logRoot, { recursive: true })
  const logPath = resolve(logRoot, `${name}.log`)
  const logStream = createWriteStream(logPath, { flags: 'a' })
  const child = spawn(args[0], args.slice(1), {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    detached: !isWindows,
  })

  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)

  const managed = { child, name }
  managedProcesses.push(managed)
  return managed
}

async function stopProcess(processToStop: ManagedProcess) {
  const hasExited = () => processToStop.child.exitCode !== null || processToStop.child.signalCode !== null

  if (hasExited())
    return

  const waitForExit = (timeoutMs: number) => {
    if (hasExited())
      return Promise.resolve(true)

    return Promise.race([
      new Promise<boolean>((resolveExit) => {
        processToStop.child.once('exit', () => resolveExit(true))
      }),
      sleep(timeoutMs).then(() => hasExited()),
    ])
  }

  const terminateProcessTree = (signal: NodeJS.Signals) => {
    if (!processToStop.child.pid)
      return

    if (isWindows) {
      const args = ['/PID', String(processToStop.child.pid), '/T']
      if (signal === 'SIGKILL')
        args.push('/F')
      spawnSync('taskkill', args, { stdio: 'ignore' })
      return
    }

    try {
      process.kill(-processToStop.child.pid, signal)
    }
    catch {
      // The process might not be the group leader on older runs.
    }
  }

  if (processToStop.child.pid) {
    terminateProcessTree('SIGTERM')
    if (!isWindows)
      spawnSync('pkill', ['-TERM', '-P', String(processToStop.child.pid)], { stdio: 'ignore' })
  }
  processToStop.child.kill('SIGTERM')
  if (await waitForExit(5000))
    return

  if (processToStop.child.pid) {
    terminateProcessTree('SIGKILL')
    if (!isWindows)
      spawnSync('pkill', ['-KILL', '-P', String(processToStop.child.pid)], { stdio: 'ignore' })
  }
  if (!hasExited())
    processToStop.child.kill('SIGKILL')
  await waitForExit(2000)
}

function parseSupabaseStatus(stdout: string): SupabaseStatus | null {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0)
    return null

  try {
    return JSON.parse(stdout.slice(jsonStart)) as SupabaseStatus
  }
  catch {
    return null
  }
}

function getSupabaseStatus(): SupabaseStatus | null {
  const result = spawnSync('bun', ['scripts/supabase-worktree.ts', 'status', '-o', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if ((result.status ?? 1) !== 0)
    return null
  return parseSupabaseStatus(result.stdout || '')
}

function readPngSize(path: string): { width: number, height: number } {
  const buffer = readFileSync(path)
  if (buffer.toString('ascii', 1, 4) !== 'PNG')
    throw new Error(`${path} is not a PNG file`)

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function verifyScreenshotSize(path: string, expectedWidth: number, expectedHeight: number) {
  const { width, height } = readPngSize(path)
  if (width !== expectedWidth || height !== expectedHeight)
    throw new Error(`${path} is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`)
}

async function ensureLocalStack() {
  if (!(await isTcpReady(stripePort))) {
    startProcess('stripe-emulator', ['bun', 'run', 'stripe:emulator'], {
      STRIPE_EMULATOR_PORT: String(stripePort),
    })
    await waitForTcp(stripePort, 60_000, 'Stripe emulator')
  }

  const backendOkUrl = `${localSupabaseUrl}/functions/v1/ok`
  const reuseBackend = process.env.APP_STORE_SCREENSHOTS_REUSE_BACKEND === 'true'
  if (!reuseBackend || !(await isHttpReady(backendOkUrl))) {
    const readyFile = resolve(repoRoot, '.context/app-store-screenshots/backend.ready')
    rmSync(readyFile, { force: true })
    startProcess('backend-playwright', ['bun', 'run', 'backend:playwright'], {
      ENV: 'local',
      STRIPE_SECRET_KEY: 'sk_test_emulator',
      STRIPE_API_BASE_URL: stripeApiBaseUrl,
      STRIPE_WEBHOOK_SECRET: 'testsecret',
      WEBAPP_URL: screenshotBaseUrl,
      PLAYWRIGHT_READY_FILE: readyFile,
    })
    await waitForFile(readyFile, 360_000, 'Supabase functions')
  }

  const status = getSupabaseStatus()
  const supabaseUrl = status?.API_URL || localSupabaseUrl
  const supabaseAnon = process.env.SUPABASE_ANON_KEY || status?.ANON_KEY || status?.PUBLISHABLE_KEY
  if (!supabaseAnon)
    throw new Error('Unable to resolve the local Supabase anon key from environment or worktree status')

  const apiDomain = supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/functions/v1'

  if (!(await isHttpReady(`${screenshotBaseUrl}/login/`))) {
    const frontendPort = new URL(screenshotBaseUrl).port || '5173'
    startProcess('frontend', ['bunx', 'vite', '--host', '127.0.0.1', '--port', frontendPort, '--strictPort'], {
      ENV: 'local',
      SUPA_URL: supabaseUrl,
      SUPA_ANON: supabaseAnon,
      API_DOMAIN: apiDomain || localApiDomain,
      CAPTCHA_KEY: '',
    })
    await waitForHttp(`${screenshotBaseUrl}/login/`, 180_000, 'frontend')
  }

  return { supabaseUrl, supabaseAnon }
}

async function seedDemoData() {
  const dbUrl = process.env.DB_URL || getSupabaseStatus()?.DB_URL
  if (!dbUrl)
    throw new Error('Unable to resolve the local database URL for the demo seed')
  // IPv6 hosts come back bracketed (`[::1]`) from URL.hostname
  const host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error(`Refusing to seed non-local database host "${host}".`)
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await client.query(readFileSync(resolve(repoRoot, 'scripts/marketing-screenshots/seed.sql'), 'utf8'))
  }
  finally {
    await client.end()
  }
}

async function prepareScreenshotData(supabaseUrl: string, supabaseAnon: string) {
  const supabase = createClient(supabaseUrl, supabaseAnon, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: 'test@capgo.app',
    password: 'testtest',
  })
  if (signInError)
    throw new Error(`Unable to sign in for screenshot data setup: ${signInError.message}`)

  const { error } = await supabase
    .from('apps')
    .update({ allow_preview: true })
    .eq('app_id', 'com.demo.app')
  if (error)
    throw new Error(`Unable to enable demo preview for screenshots: ${error.message}`)
}

// Runs in the browser before every navigation: keep first-run hints, the
// support usernames prompt, and the dev-server Vue DevTools button out of store screenshots.
function hideScreenshotNoise() {
  localStorage.setItem('capgo-section-intro-dismissed', JSON.stringify(['apps', 'bundles', 'channels', 'builds', 'devices', 'apikeys']))
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith('sb-') || !key.endsWith('-auth-token'))
      continue
    try {
      const userId = JSON.parse(localStorage.getItem(key) || '{}')?.user?.id
      if (userId)
        localStorage.setItem(`capgo.supportUsernames.dismissed.${userId}`, '1')
    }
    catch {}
  }
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = '#__vue-devtools-container__, [id^="vue-devtools"] { display: none !important; }'
    document.head.appendChild(style)
  })
}

async function login(page: Page) {
  await page.goto('/login/', { waitUntil: 'domcontentloaded' })
  await page.fill('[data-test="email"]', 'test@capgo.app')
  await page.waitForSelector('[data-test="password"]', { timeout: 30_000 })
  await page.fill('[data-test="password"]', 'testtest')
  await page.click('[data-test="submit"]')
  // Match the pathname only: a bounced login lands on /login?to=/dashboard
  await page.waitForURL(url => /^\/(?:apps|dashboard)(?:\/|$)/.test(url.pathname), { timeout: 60_000 })
}

async function settlePage(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.addStyleTag({ content: hideChromeCss }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(3000)
  // Re-apply: some pages mount their chrome after the first paint
  await page.addStyleTag({ content: hideChromeCss }).catch(() => {})
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fileUrl(path: string) {
  return pathToFileURL(path).href
}

const pageStyle = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
    background:
      radial-gradient(120% 70% at 50% 0%, rgba(17, 158, 255, 0.28) 0%, rgba(17, 158, 255, 0) 60%),
      radial-gradient(90% 60% at 100% 100%, rgba(31, 178, 165, 0.18) 0%, rgba(31, 178, 165, 0) 70%),
      linear-gradient(180deg, #001a2c 0%, #04253d 100%);
    -webkit-font-smoothing: antialiased;
  }
  .phone {
    position: absolute;
    background: #0a1622;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14), 0 40px 80px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }
  .phone img { display: block; width: 100%; height: auto; }
`

function framedScreenHtml(device: ScreenshotDevice, screen: (typeof screens)[number], rawPath: string) {
  const m = frameMetrics(device)
  const titleSize = Math.min(device.cssWidth * 0.085, device.cssHeight * 0.05)
  const subtitleSize = titleSize * 0.46
  const radius = Math.round(m.frameWidth * 0.1)
  return `<!doctype html><html><head><meta charset="utf-8"><style>${pageStyle}
    .copy { position: absolute; left: 7%; right: 7%; top: 0; height: ${m.frameTop}px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: ${Math.round(subtitleSize * 0.7)}px; }
    h1 { font-size: ${titleSize}px; font-weight: 800; line-height: 1.08; letter-spacing: -0.025em; text-wrap: balance; }
    p { font-size: ${subtitleSize}px; font-weight: 500; line-height: 1.3; color: #a9c4dc; text-wrap: balance; }
    .phone { left: ${Math.round((device.cssWidth - m.frameWidth) / 2)}px; top: ${m.frameTop}px; width: ${m.frameWidth}px; padding: ${m.bezel}px; border-radius: ${radius}px; }
    .phone img { border-radius: ${radius - m.bezel}px; }
  </style></head><body>
    <div class="copy"><h1>${escapeHtml(screen.title)}</h1><p>${escapeHtml(screen.subtitle)}</p></div>
    <div class="phone"><img src="${fileUrl(rawPath)}"></div>
  </body></html>`
}

// Three phones fanned around the center: App Store crops headers per device, so the focal point stays centered
function creativeHtml(asset: CreativeAsset, rawPaths: string[]) {
  const { cssWidth: w, cssHeight: h } = asset
  const mark = fileUrl(brandMarkPath)
  if (asset.layout === 'feature') {
    const phoneWidth = 200
    return `<!doctype html><html><head><meta charset="utf-8"><style>${pageStyle}
      .brand { position: absolute; left: 64px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; gap: 18px; }
      .logo { display: flex; align-items: center; gap: 16px; font-size: 44px; font-weight: 800; letter-spacing: -0.02em; }
      .logo img { width: 60px; height: 60px; }
      h1 { font-size: 40px; font-weight: 800; line-height: 1.08; white-space: nowrap; letter-spacing: -0.025em; }
      p { font-size: 21px; font-weight: 500; color: #a9c4dc; }
      .phone { width: ${phoneWidth}px; padding: 5px; border-radius: 26px; }
      .phone img { border-radius: 21px; }
    </style></head><body>
      <div class="brand"><div class="logo"><img src="${mark}">Capgo</div><h1>Ship app updates in minutes</h1><p>Live updates for Capacitor apps</p></div>
      <div class="phone" style="left: 610px; top: 96px;"><img src="${fileUrl(rawPaths[3])}"></div>
      <div class="phone" style="left: 790px; top: 48px;"><img src="${fileUrl(rawPaths[0])}"></div>
    </body></html>`
  }

  const isHeader = asset.layout === 'header'
  const titleSize = Math.round(h * (isHeader ? 0.075 : 0.065))
  const copyHeight = Math.round(h * (isHeader ? 0.24 : 0.22))
  const phoneWidth = Math.round(h * (isHeader ? 0.42 : 0.4))
  const gap = Math.round(phoneWidth * 0.08)
  const centerTop = copyHeight + Math.round(h * 0.03)
  const sideTop = centerTop + Math.round(h * 0.08)
  const centerLeft = Math.round((w - phoneWidth) / 2)
  const title = isHeader ? 'Ship app updates in minutes' : 'Live updates for Capacitor apps'
  return `<!doctype html><html><head><meta charset="utf-8"><style>${pageStyle}
    .copy { position: absolute; left: 0; right: 0; top: 0; height: ${copyHeight}px; display: flex; align-items: flex-end; justify-content: center; }
    h1 { font-size: ${titleSize}px; font-weight: 800; letter-spacing: -0.025em; }
    .phone { width: ${phoneWidth}px; padding: ${Math.round(phoneWidth * 0.018)}px; border-radius: ${Math.round(phoneWidth * 0.1)}px; }
    .phone img { border-radius: ${Math.round(phoneWidth * 0.082)}px; }
  </style></head><body>
    <div class="copy"><h1>${title}</h1></div>
    <div class="phone" style="left: ${centerLeft - phoneWidth - gap}px; top: ${sideTop}px;"><img src="${fileUrl(rawPaths[3])}"></div>
    <div class="phone" style="left: ${centerLeft + phoneWidth + gap}px; top: ${sideTop}px;"><img src="${fileUrl(rawPaths[2])}"></div>
    <div class="phone" style="left: ${centerLeft}px; top: ${centerTop}px; z-index: 1;"><img src="${fileUrl(rawPaths[0])}"></div>
  </body></html>`
}

async function renderHtml(browser: Browser, html: string, name: string, cssWidth: number, cssHeight: number, scale: number, outputPath: string) {
  mkdirSync(composeRoot, { recursive: true })
  const htmlPath = resolve(composeRoot, `${name}.html`)
  writeFileSync(htmlPath, html)
  const context = await browser.newContext({ viewport: { width: cssWidth, height: cssHeight }, deviceScaleFactor: scale })
  try {
    const page = await context.newPage()
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    mkdirSync(dirname(outputPath), { recursive: true })
    await page.screenshot({ path: outputPath, fullPage: false, animations: 'disabled' })
    verifyScreenshotSize(outputPath, cssWidth * scale, cssHeight * scale)
  }
  finally {
    await context.close()
  }
}

async function captureRawScreens(browser: Browser, device: ScreenshotDevice) {
  const { rawWidth, rawHeight } = frameMetrics(device)
  const context = await browser.newContext({
    baseURL: screenshotBaseUrl,
    viewport: { width: rawWidth, height: rawHeight },
    deviceScaleFactor: device.scale,
    hasTouch: device.mobile,
    isMobile: device.mobile,
    locale: 'en-US',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    timezoneId: 'UTC',
  })
  await context.addInitScript(hideScreenshotNoise)
  const page = await context.newPage()
  await installMocks(page)
  const rawPaths: string[] = []
  try {
    await login(page)
    for (const screen of screens) {
      await page.goto(screen.path, { waitUntil: 'domcontentloaded' })
      await settlePage(page)
      await screen.prepare?.(page)
      await maskIdentities(page)
      const rawPath = resolve(rawRoot, device.slug, `${screen.slug}.png`)
      mkdirSync(dirname(rawPath), { recursive: true })
      await page.screenshot({ path: rawPath, fullPage: false, animations: 'disabled', caret: 'hide' })
      rawPaths.push(rawPath)
    }
  }
  finally {
    await context.close()
  }
  return rawPaths
}

async function captureScreenshots() {
  for (const dir of [outputRoot, appStoreAssetsRoot, rawRoot, ...androidScreenshotDirs.map(dir => resolve(androidOutputRoot, dir))]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }

  const browser = await chromium.launch({ headless: true })
  try {
    let creativeRawPaths: string[] = []
    for (const device of devices) {
      const rawPaths = await captureRawScreens(browser, device)
      if (device.slug === 'iphone-6-9')
        creativeRawPaths = rawPaths

      let appleIndex = 0
      for (const [index, screen] of screens.entries()) {
        if (screen.playOnly && device.androidDirs.length === 0)
          continue
        const androidName = `${String(index + 1).padStart(2, '0')}-${screen.slug}.png`
        const fileName = screen.playOnly ? androidName : `${device.filePrefix}-${String(++appleIndex).padStart(2, '0')}-${screen.slug}.png`
        const outputPath = screen.playOnly ? resolve(composeRoot, device.slug, androidName) : resolve(device.outputDir ?? outputRoot, fileName)
        await renderHtml(browser, framedScreenHtml(device, screen, rawPaths[index]), `${device.slug}-${screen.slug}`, device.cssWidth, device.cssHeight, device.scale, outputPath)
        for (const dir of device.androidDirs)
          copyFileSync(outputPath, resolve(androidOutputRoot, dir, androidName))
        console.log(`${device.slug}: ${fileName}`)
      }
    }

    for (const asset of creativeAssets) {
      await renderHtml(browser, creativeHtml(asset, creativeRawPaths), asset.fileName.replace('.png', ''), asset.cssWidth, asset.cssHeight, asset.scale, resolve(appStoreAssetsRoot, 'creative', asset.fileName))
      console.log(`creative: ${asset.fileName}`)
    }
    await renderHtml(browser, creativeHtml(featureGraphic, creativeRawPaths), 'feature-graphic', featureGraphic.cssWidth, featureGraphic.cssHeight, featureGraphic.scale, resolve(androidOutputRoot, featureGraphic.fileName))
    console.log(`android: ${featureGraphic.fileName}`)
  }
  finally {
    await browser.close()
  }
}

try {
  const localStack = await ensureLocalStack()
  await seedDemoData()
  await prepareScreenshotData(localStack.supabaseUrl, localStack.supabaseAnon)
  await captureScreenshots()
  console.log(`Screenshots written to ${outputRoot}, ${appStoreAssetsRoot} and ${androidOutputRoot}`)
}
finally {
  for (const managed of managedProcesses.reverse())
    await stopProcess(managed)
}
