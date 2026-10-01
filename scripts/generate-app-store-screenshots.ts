import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import net from 'node:net'
import type { Page } from '@playwright/test'
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
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
}

interface ScreenshotDevice {
  slug: string
  filePrefix: string
  cssWidth: number
  cssHeight: number
  scale: number
  expectedWidth: number
  expectedHeight: number
  mobile: boolean
  // Google Play screenshot folders that reuse this capture
  androidDirs: string[]
}

const repoRoot = process.cwd()
const outputRoot = resolve(repoRoot, 'fastlane/screenshots/en-US')
const androidOutputRoot = resolve(repoRoot, 'fastlane/metadata/android/en-US/images')
const androidScreenshotDirs = ['phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots']
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
    filePrefix: 'iPhone 14 Pro Max',
    cssWidth: 430,
    cssHeight: 932,
    scale: 3,
    expectedWidth: 1290,
    expectedHeight: 2796,
    mobile: true,
    androidDirs: [],
  },
  {
    slug: 'iphone-6-5',
    filePrefix: 'iPhone XS Max',
    cssWidth: 428,
    cssHeight: 926,
    scale: 3,
    expectedWidth: 1284,
    expectedHeight: 2778,
    mobile: true,
    androidDirs: [],
  },
  {
    slug: 'iphone-5-5',
    filePrefix: 'iPhone 6 Plus',
    cssWidth: 414,
    cssHeight: 736,
    scale: 3,
    expectedWidth: 1242,
    expectedHeight: 2208,
    mobile: true,
    androidDirs: ['phoneScreenshots'],
  },
  {
    slug: 'ipad-13',
    filePrefix: 'iPad Pro (12.9-inch) (3rd generation)',
    cssWidth: 1024,
    cssHeight: 1366,
    scale: 2,
    expectedWidth: 2048,
    expectedHeight: 2732,
    mobile: false,
    androidDirs: ['sevenInchScreenshots', 'tenInchScreenshots'],
  },
]

const screens = [
  { slug: 'dashboard', path: '/dashboard' },
  { slug: 'apps', path: '/apps' },
  { slug: 'app-overview', path: '/app/com.demo.app' },
  { slug: 'channels', path: '/app/com.demo.app/channels' },
  { slug: 'devices', path: '/app/com.demo.app/devices' },
  { slug: 'preview-qr', path: '/app/com.demo.app/channel/1/preview?appStoreQr=1' },
]

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

function verifyScreenshotSize(path: string, device: ScreenshotDevice) {
  const { width, height } = readPngSize(path)
  if (width !== device.expectedWidth || height !== device.expectedHeight) {
    throw new Error(
      `${path} is ${width}x${height}, expected ${device.expectedWidth}x${device.expectedHeight}`,
    )
  }
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
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(1600)
  await page.evaluate(() => {
    document.documentElement.style.caretColor = 'transparent'
  })
}

async function captureScreenshots() {
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })
  for (const dir of androidScreenshotDirs) {
    rmSync(resolve(androidOutputRoot, dir), { recursive: true, force: true })
    mkdirSync(resolve(androidOutputRoot, dir), { recursive: true })
  }

  const browser = await chromium.launch({ headless: true })
  try {
    for (const device of devices) {
      const context = await browser.newContext({
        baseURL: screenshotBaseUrl,
        viewport: { width: device.cssWidth, height: device.cssHeight },
        deviceScaleFactor: device.scale,
        hasTouch: device.mobile,
        isMobile: device.mobile,
        locale: 'en-US',
        reducedMotion: 'reduce',
        colorScheme: 'light',
      })
      await context.addInitScript(hideScreenshotNoise)
      const page = await context.newPage()

      try {
        await login(page)

        for (const [index, screen] of screens.entries()) {
          await page.goto(screen.path, { waitUntil: 'domcontentloaded' })
          await settlePage(page)

          const baseName = `${String(index + 1).padStart(2, '0')}-${screen.slug}.png`
          const fileName = `${device.filePrefix}-${baseName}`
          const outputPath = resolve(outputRoot, fileName)
          mkdirSync(dirname(outputPath), { recursive: true })
          await page.screenshot({
            path: outputPath,
            fullPage: false,
            animations: 'disabled',
            caret: 'hide',
          })
          verifyScreenshotSize(outputPath, device)
          for (const dir of device.androidDirs)
            copyFileSync(outputPath, resolve(androidOutputRoot, dir, baseName))
          console.log(`${device.slug}: ${fileName}`)
        }
      }
      finally {
        await context.close()
      }
    }
  }
  finally {
    await browser.close()
  }
}

try {
  const localStack = await ensureLocalStack()
  await prepareScreenshotData(localStack.supabaseUrl, localStack.supabaseAnon)
  await captureScreenshots()
  console.log(`Screenshots written to ${outputRoot} and ${androidOutputRoot}`)
}
finally {
  for (const managed of managedProcesses.reverse())
    await stopProcess(managed)
}
