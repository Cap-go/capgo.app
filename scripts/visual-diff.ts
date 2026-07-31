import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import type { Page } from '@playwright/test'
import { chromium } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import type { VisualDiffRoute } from '../playwright/visual-diff.config'
import { getSupabaseStatus } from './supabase-worktree-status'
import { getPlaywrightStripeApiBaseUrl, getStripeEmulatorPort } from './playwright-stripe'
import { getSupabaseWorktreeConfig } from './supabase-worktree-config'

type Phase = 'before' | 'after'
type Command = 'capture' | 'capture-route' | 'diff' | 'run'

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams
  name: string
}

interface DiffResult {
  slug: string
  changed: boolean
  diffPixels: number
  totalPixels: number
  diffPercent: number
  beforePath: string
  afterPath: string
  diffPath: string
}

interface CliOptions {
  command: Command
  phase?: Phase
  baseRef?: string
  headRef?: string
  thresholdPercent: number
  routes: string[]
  skipGitCheckout: boolean
}

const repoRoot = process.cwd()
const defaultVisualDiffConfigPath = process.env.VISUAL_DIFF_CONFIG_PATH || resolve(repoRoot, 'playwright/visual-diff.config.ts')

interface LoadedVisualDiffConfig {
  visualDiffRoutes: VisualDiffRoute[]
  visualDiffViewport: { width: number, height: number }
}

async function loadVisualDiffConfig(configPath = defaultVisualDiffConfigPath): Promise<LoadedVisualDiffConfig> {
  const module = await import(pathToFileURL(configPath).href)
  return {
    visualDiffRoutes: module.visualDiffRoutes as VisualDiffRoute[],
    visualDiffViewport: module.visualDiffViewport as LoadedVisualDiffConfig['visualDiffViewport'],
  }
}

const outputRoot = resolve(repoRoot, '.context/visual-diff')
const logRoot = resolve(outputRoot, 'logs')
const frontendBaseUrl = process.env.VISUAL_DIFF_BASE_URL || 'http://127.0.0.1:5173'
const supabaseConfig = getSupabaseWorktreeConfig(repoRoot)
const localSupabaseUrl = `http://127.0.0.1:${supabaseConfig.ports.api}`
const localApiDomain = `127.0.0.1:${supabaseConfig.ports.api}/functions/v1`
const stripePort = getStripeEmulatorPort(process.env)
const stripeApiBaseUrl = getPlaywrightStripeApiBaseUrl(process.env)
const managedProcesses: ManagedProcess[] = []
const isWindows = process.platform === 'win32'
const httpReadyTimeoutMs = 5_000
const visualDiffActionTimeoutMs = 60_000
const visualDiffRouteTimeoutMs = 120_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseThreshold(raw: string, source: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`${source} must be a number between 0 and 100, received "${raw}"`)
  return value
}

function parseArgs(argv: string[]): CliOptions {
  const [commandRaw, ...rest] = argv
  const command = (commandRaw || 'run') as Command
  if (!['capture', 'capture-route', 'diff', 'run'].includes(command)) {
    throw new Error(`Unknown command "${commandRaw}". Use capture, capture-route, diff, or run.`)
  }

  let phase: Phase | undefined
  let baseRef = process.env.VISUAL_DIFF_BASE_REF
  let headRef = process.env.VISUAL_DIFF_HEAD_REF
  let thresholdPercent = parseThreshold(process.env.VISUAL_DIFF_THRESHOLD_PERCENT || '0.1', 'VISUAL_DIFF_THRESHOLD_PERCENT')
  let routes: string[] = []
  let skipGitCheckout = process.env.VISUAL_DIFF_SKIP_GIT === 'true'

  function requireArg(flag: string, value: string | undefined) {
    if (!value || value.startsWith('--'))
      throw new Error(`${flag} requires a value`)
    return value
  }

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--phase') {
      phase = requireArg('--phase', rest[++index]) as Phase
      continue
    }
    if (arg === '--base') {
      baseRef = requireArg('--base', rest[++index])
      continue
    }
    if (arg === '--head') {
      headRef = requireArg('--head', rest[++index])
      continue
    }
    if (arg === '--threshold') {
      const rawThreshold = requireArg('--threshold', rest[++index])
      thresholdPercent = parseThreshold(rawThreshold, '--threshold')
      continue
    }
    if (arg === '--routes') {
      routes = requireArg('--routes', rest[++index]).split(',').map(route => route.trim()).filter(Boolean)
      continue
    }
    if (arg === '--skip-git') {
      skipGitCheckout = true
      continue
    }
    throw new Error(`Unknown argument "${arg}"`)
  }

  if ((command === 'capture' || command === 'capture-route') && phase !== 'before' && phase !== 'after') {
    throw new Error(`${command} requires --phase before or --phase after`)
  }

  if (command === 'capture-route' && routes.length !== 1)
    throw new Error('capture-route requires exactly one --routes slug')

  return {
    command,
    phase,
    baseRef,
    headRef,
    thresholdPercent,
    routes,
    skipGitCheckout,
  }
}

function selectedRoutes(routes: VisualDiffRoute[], routeFilter: string[]) {
  if (routeFilter.length === 0)
    return routes

  const known = new Set(routes.map(route => route.slug))
  for (const slug of routeFilter) {
    if (!known.has(slug))
      throw new Error(`Unknown visual diff route "${slug}"`)
  }

  return routes.filter(route => routeFilter.includes(route.slug))
}

function phaseDir(phase: Phase) {
  return resolve(outputRoot, phase)
}

function reportDir() {
  return resolve(outputRoot, 'report')
}

function diffDir() {
  return resolve(outputRoot, 'diff')
}

async function isHttpReady(url: string, options: { requireSuccess?: boolean } = {}): Promise<boolean> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      fetch(url, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(`Timed out waiting for ${url}`))
        }, httpReadyTimeoutMs)
      }),
    ])
    return options.requireSuccess ? response.ok : response.status < 500
  }
  catch {
    return false
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
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

  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })
  child.on('close', () => {
    logStream.end()
  })

  const managed = { child, name }
  managedProcesses.push(managed)
  return managed
}

async function stopProcess(processToStop: ManagedProcess) {
  const hasExited = () => processToStop.child.exitCode !== null || processToStop.child.signalCode !== null

  if (hasExited())
    return

  const waitForExit = async (timeoutMs: number) => {
    if (hasExited())
      return true

    return Promise.race([
      new Promise<boolean>((resolveExit) => {
        processToStop.child.once('exit', () => resolveExit(true))
      }),
      (async () => {
        await sleep(timeoutMs)
        return hasExited()
      })(),
    ])
  }

  if (processToStop.child.pid) {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(processToStop.child.pid), '/T'], { stdio: 'ignore' })
    }
    else {
      try {
        process.kill(-processToStop.child.pid, 'SIGTERM')
      }
      catch {
        // ignore
      }
      spawnSync('pkill', ['-TERM', '-P', String(processToStop.child.pid)], { stdio: 'ignore' })
    }
  }
  processToStop.child.kill('SIGTERM')
  if (await waitForExit(5000))
    return

  if (processToStop.child.pid && !isWindows) {
    try {
      process.kill(-processToStop.child.pid, 'SIGKILL')
    }
    catch {
      // ignore
    }
    spawnSync('pkill', ['-KILL', '-P', String(processToStop.child.pid)], { stdio: 'ignore' })
  }
  processToStop.child.kill('SIGKILL')
  await waitForExit(2000)
}

function waitForManagedProcess(managed: ManagedProcess, timeoutMs: number, label: string) {
  const { child } = managed
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode === 0)
      return Promise.resolve()
    return Promise.reject(new Error(`${label} exited before it completed`))
  }

  return new Promise<void>((resolveProcess, rejectProcess) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void) => {
      if (settled)
        return
      settled = true
      if (timeout)
        clearTimeout(timeout)
      callback()
    }
    const onError = (error: Error) => finish(() => rejectProcess(error))
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(() => {
      if (code === 0) {
        resolveProcess()
        return
      }
      rejectProcess(new Error(`${label} exited with code ${code ?? 'none'}${signal ? ` (${signal})` : ''}`))
    })

    timeout = setTimeout(() => {
      finish(() => rejectProcess(new Error(`Timed out ${label} after ${timeoutMs}ms`)))
    }, timeoutMs)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function captureRouteInChild(phase: Phase, route: VisualDiffRoute, configPath: string, runnerPath: string) {
  const captureProcess = startProcess(
    `capture-${phase}-${route.slug}`,
    [process.execPath, runnerPath, 'capture-route', '--phase', phase, '--routes', route.slug],
    { VISUAL_DIFF_CONFIG_PATH: configPath },
  )
  try {
    await waitForManagedProcess(captureProcess, visualDiffRouteTimeoutMs, `capturing ${phase} ${route.slug}`)
  }
  catch (error) {
    await stopProcess(captureProcess)
    throw error
  }
  finally {
    const index = managedProcesses.indexOf(captureProcess)
    if (index >= 0)
      managedProcesses.splice(index, 1)
  }
}

async function stopAllProcesses() {
  for (const managed of [...managedProcesses].reverse())
    await stopProcess(managed)
  managedProcesses.length = 0
}

function git(args: string[]) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return (result.stdout || '').trim()
}

function resolveGitRef(ref: string | undefined, fallback: string) {
  if (!ref)
    return fallback
  return git(['rev-parse', ref])
}

async function stopBackendStack() {
  for (let index = managedProcesses.length - 1; index >= 0; index--) {
    if (managedProcesses[index].name !== 'backend-playwright')
      continue
    await stopProcess(managedProcesses[index])
    managedProcesses.splice(index, 1)
  }
  rmSync(resolve(outputRoot, 'backend.ready'), { force: true })
  if (!isWindows)
    spawnSync('pkill', ['-f', 'supabase-functions.playwright.env'], { stdio: 'ignore' })
}

async function ensureBackendStack(options: { force?: boolean } = {}) {
  if (!(await isTcpReady(stripePort))) {
    startProcess('stripe-emulator', ['bun', 'run', 'stripe:emulator'], {
      STRIPE_EMULATOR_PORT: String(stripePort),
    })
    await waitForTcp(stripePort, 60_000, 'Stripe emulator')
  }

  const backendOkUrl = `${localSupabaseUrl}/functions/v1/ok`
  if (options.force || !(await isHttpReady(backendOkUrl, { requireSuccess: true }))) {
    await stopBackendStack()
    const readyFile = resolve(outputRoot, 'backend.ready')
    rmSync(readyFile, { force: true })
    startProcess('backend-playwright', ['bun', 'run', 'backend:playwright'], {
      ENV: 'local',
      STRIPE_SECRET_KEY: 'sk_test_emulator',
      STRIPE_API_BASE_URL: stripeApiBaseUrl,
      STRIPE_WEBHOOK_SECRET: 'testsecret',
      WEBAPP_URL: frontendBaseUrl,
      PLAYWRIGHT_READY_FILE: readyFile,
    })
    await waitForFile(readyFile, 360_000, 'Supabase functions')
  }

  const status = getSupabaseStatus()
  const supabaseUrl = status?.API_URL || localSupabaseUrl
  const supabaseAnon = process.env.SUPABASE_ANON_KEY || status?.ANON_KEY || status?.PUBLISHABLE_KEY
  if (!supabaseAnon)
    throw new Error('Unable to resolve the local Supabase anon key')

  return {
    supabaseUrl,
    supabaseAnon,
    apiDomain: supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/functions/v1',
  }
}

async function stopFrontendStack() {
  for (let index = managedProcesses.length - 1; index >= 0; index--) {
    if (managedProcesses[index].name !== 'frontend-preview')
      continue
    await stopProcess(managedProcesses[index])
    managedProcesses.splice(index, 1)
  }
  if (!isWindows)
    spawnSync('pkill', ['-f', 'vite preview --host 127.0.0.1 --port 5173'], { stdio: 'ignore' })
}

async function ensureFrontendStack(
  supabaseUrl: string,
  supabaseAnon: string,
  apiDomain: string,
  options: { force?: boolean } = {},
) {
  if (!options.force && await isHttpReady(`${frontendBaseUrl}/login/`))
    return

  await stopFrontendStack()
  const build = spawnSync('bun', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ENV: 'local',
      SUPA_URL: supabaseUrl,
      SUPA_ANON: supabaseAnon,
      API_DOMAIN: apiDomain || localApiDomain,
      CAPTCHA_KEY: '',
    },
  })
  if ((build.status ?? 1) !== 0)
    throw new Error('Frontend build failed')

  startProcess('frontend-preview', ['bunx', 'vite', 'preview', '--host', '127.0.0.1', '--port', '5173'], {
    ENV: 'local',
    SUPA_URL: supabaseUrl,
    SUPA_ANON: supabaseAnon,
    API_DOMAIN: apiDomain || localApiDomain,
    CAPTCHA_KEY: '',
  })
  await waitForHttp(`${frontendBaseUrl}/login/`, 180_000, 'frontend preview')
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
    throw new Error(`Unable to sign in for visual diff setup: ${signInError.message}`)
}

async function login(page: Page) {
  await page.goto('/login/', { waitUntil: 'domcontentloaded' })
  await page.fill('[data-test="email"]', 'test@capgo.app')
  await page.click('[data-test="continue"]')
  await page.waitForSelector('[data-test="password"]', { timeout: 30_000 })
  await page.fill('[data-test="password"]', 'testtest')

  const submit = page.locator('[data-test="submit"]')
  if (await submit.isEnabled())
    await submit.click()
  else
    await page.keyboard.press('Enter')

  await page.waitForURL(/\/(apps|dashboard)(\/|$)/, { timeout: 60_000 })
}

async function settlePage(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(1200)
  await page.evaluate(() => {
    document.documentElement.style.caretColor = 'transparent'
  })
}

async function captureRouteScreenshot(
  phase: Phase,
  route: VisualDiffRoute,
  visualDiffViewport: LoadedVisualDiffConfig['visualDiffViewport'],
) {
  const targetDir = phaseDir(phase)
  mkdirSync(targetDir, { recursive: true })

  console.log(`[visual-diff] launching browser for ${phase} ${route.slug}`)
  const browser = await chromium.launch({ headless: true, timeout: visualDiffActionTimeoutMs })
  try {
    console.log(`[visual-diff] creating browser context for ${phase} ${route.slug}`)
    const context = await browser.newContext({
      baseURL: frontendBaseUrl,
      viewport: visualDiffViewport,
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(visualDiffActionTimeoutMs)
    page.setDefaultNavigationTimeout(visualDiffActionTimeoutMs)

    if (route.auth) {
      console.log(`[visual-diff] logging in for ${phase} ${route.slug}`)
      await login(page)
      console.log(`[visual-diff] logged in for ${phase} ${route.slug}`)
    }

    console.log(`[visual-diff] navigating ${phase} ${route.slug}`)
    await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: visualDiffActionTimeoutMs })
    console.log(`[visual-diff] settling ${phase} ${route.slug}`)
    await settlePage(page)
    if (route.prepare) {
      console.log(`[visual-diff] preparing ${phase} ${route.slug}`)
      await route.prepare(page)
      await settlePage(page)
    }
    const outputPath = resolve(targetDir, `${route.slug}.png`)
    console.log(`[visual-diff] screenshotting ${phase} ${route.slug}`)
    await page.screenshot({ path: outputPath, fullPage: false, timeout: visualDiffActionTimeoutMs })
    console.log(`[visual-diff] captured ${phase} ${route.slug} -> ${outputPath}`)
    await context.close()
  }
  finally {
    await browser.close()
  }
}

async function captureScreenshots(
  phase: Phase,
  routeFilter: string[],
  options: { forceFrontend?: boolean, forceBackend?: boolean } = {},
  config?: LoadedVisualDiffConfig,
  configPath = defaultVisualDiffConfigPath,
  runnerPath = resolve(repoRoot, 'scripts/visual-diff.ts'),
) {
  const { visualDiffRoutes } = config ?? await loadVisualDiffConfig(configPath)
  const routes = selectedRoutes(visualDiffRoutes, routeFilter)
  mkdirSync(phaseDir(phase), { recursive: true })

  console.log(`[visual-diff] preparing ${phase} capture stack`)
  const { supabaseUrl, supabaseAnon, apiDomain } = await ensureBackendStack({ force: options.forceBackend })
  await prepareScreenshotData(supabaseUrl, supabaseAnon)
  await ensureFrontendStack(supabaseUrl, supabaseAnon, apiDomain, { force: options.forceFrontend })
  console.log(`[visual-diff] ${phase} frontend ready`)

  for (const route of routes) {
    console.log(`[visual-diff] capturing ${phase} ${route.slug} in an isolated browser`)
    await captureRouteInChild(phase, route, configPath, runnerPath)
    console.log(`[visual-diff] captured ${phase} ${route.slug}`)
  }
}

function readPng(path: string) {
  return PNG.sync.read(readFileSync(path))
}

function writeDiffImage(beforePath: string, afterPath: string, diffPath: string) {
  const before = readPng(beforePath)
  const after = readPng(afterPath)

  if (before.width !== after.width || before.height !== after.height) {
    const width = Math.max(before.width, after.width)
    const height = Math.max(before.height, after.height)
    const diff = new PNG({ width, height })
    const mismatchPixels = width * height
    mkdirSync(dirname(diffPath), { recursive: true })
    writeFileSync(diffPath, PNG.sync.write(diff))
    return {
      diffPixels: mismatchPixels,
      totalPixels: mismatchPixels,
      diffPercent: 100,
      sizeMismatch: true,
    }
  }

  const { width, height } = before
  const diff = new PNG({ width, height })
  const diffPixels = pixelmatch(before.data, after.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: true,
  })

  mkdirSync(dirname(diffPath), { recursive: true })
  writeFileSync(diffPath, PNG.sync.write(diff))

  const totalPixels = width * height
  return {
    diffPixels,
    totalPixels,
    diffPercent: totalPixels === 0 ? 0 : (diffPixels / totalPixels) * 100,
    sizeMismatch: false,
  }
}

async function compareScreenshots(
  thresholdPercent: number,
  routeFilter: string[],
  config?: LoadedVisualDiffConfig,
): Promise<DiffResult[]> {
  const beforeRoot = phaseDir('before')
  const afterRoot = phaseDir('after')
  const { visualDiffRoutes } = config ?? await loadVisualDiffConfig()
  const routes = selectedRoutes(visualDiffRoutes, routeFilter)
  const results: DiffResult[] = []

  for (const route of routes) {
    const beforePath = resolve(beforeRoot, `${route.slug}.png`)
    const afterPath = resolve(afterRoot, `${route.slug}.png`)
    const diffPath = resolve(diffDir(), `${route.slug}-diff.png`)

    if (!existsSync(beforePath) || !existsSync(afterPath)) {
      if (routeFilter.length > 0) {
        throw new Error(`Missing screenshot pair for ${route.slug}. Capture before and after first.`)
      }
      console.warn(`[visual-diff] skipping ${route.slug}: missing before/after screenshot pair`)
      continue
    }

    const comparison = writeDiffImage(beforePath, afterPath, diffPath)
    results.push({
      slug: route.slug,
      changed: comparison.diffPercent > thresholdPercent || comparison.sizeMismatch,
      diffPixels: comparison.diffPixels,
      totalPixels: comparison.totalPixels,
      diffPercent: comparison.diffPercent,
      beforePath,
      afterPath,
      diffPath,
    })
  }

  if (results.length === 0 && routes.length > 0) {
    throw new Error(`No screenshot pairs available to compare for ${routes.length} configured route(s). Capture before and after first.`)
  }

  return results
}

function generateReport(results: DiffResult[], thresholdPercent: number) {
  const outDir = reportDir()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  for (const result of results) {
    const beforeDest = resolve(outDir, 'before', `${result.slug}.png`)
    const afterDest = resolve(outDir, 'after', `${result.slug}.png`)
    const diffDest = resolve(outDir, 'diff', `${result.slug}-diff.png`)
    mkdirSync(dirname(beforeDest), { recursive: true })
    mkdirSync(dirname(afterDest), { recursive: true })
    mkdirSync(dirname(diffDest), { recursive: true })
    writeFileSync(beforeDest, readFileSync(result.beforePath))
    writeFileSync(afterDest, readFileSync(result.afterPath))
    writeFileSync(diffDest, readFileSync(result.diffPath))
  }

  const changed = results.filter(result => result.changed)
  const unchanged = results.filter(result => !result.changed)

  const summary = {
    generatedAt: new Date().toISOString(),
    thresholdPercent,
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    routes: results,
  }
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

  const summaryMarkdown = [
    '## Visual changes',
    '',
    `Generated at ${summary.generatedAt}. Threshold: ${thresholdPercent}% pixel difference.`,
  ]

  if (changed.length === 0) {
    summaryMarkdown.push('', 'No visual differences detected for the configured routes.')
  }
  else {
    summaryMarkdown.push('', '| Route | Diff % | Status |', '| --- | ---: | --- |')
    for (const result of results) {
      summaryMarkdown.push(
        `| ${result.slug} | ${result.diffPercent.toFixed(3)} | ${result.changed ? 'changed' : 'unchanged'} |`,
      )
    }
  }

  writeFileSync(resolve(outDir, 'summary.md'), `${summaryMarkdown.join('\n')}\n`)

  const htmlRows = results.map((result) => {
    const before = `before/${result.slug}.png`
    const after = `after/${result.slug}.png`
    const diff = `diff/${result.slug}-diff.png`
    return `
      <section class="route ${result.changed ? 'changed' : 'unchanged'}">
        <h2>${result.slug} <span>${result.diffPercent.toFixed(3)}%</span></h2>
        <div class="grid">
          <figure><figcaption>Before</figcaption><img src="${before}" alt="${result.slug} before"></figure>
          <figure><figcaption>After</figcaption><img src="${after}" alt="${result.slug} after"></figure>
          <figure><figcaption>Diff</figcaption><img src="${diff}" alt="${result.slug} diff"></figure>
        </div>
      </section>
    `
  }).join('\n')

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Capgo visual diff report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; background: #0f172a; color: #e2e8f0; }
    h1 { margin-bottom: 8px; }
    .meta { color: #94a3b8; margin-bottom: 24px; }
    .route { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #334155; }
    .route.changed h2 span { color: #f87171; }
    .route.unchanged h2 span { color: #4ade80; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    figure { margin: 0; }
    figcaption { margin-bottom: 8px; color: #94a3b8; }
    img { width: 100%; border: 1px solid #334155; border-radius: 8px; background: #111827; }
  </style>
</head>
<body>
  <h1>Capgo visual diff</h1>
  <p class="meta">Changed routes: ${changed.length} · Unchanged routes: ${unchanged.length} · Threshold: ${thresholdPercent}%</p>
  ${htmlRows}
</body>
</html>
`
  writeFileSync(resolve(outDir, 'index.html'), html)
  console.log(`[visual-diff] report written to ${outDir}`)
  return summary
}

function bundleVisualDiffModule(sourcePath: string, snapshotPath: string) {
  const build = spawnSync('bun', [
    'build',
    sourcePath,
    '--bundle',
    '--target=bun',
    '--packages=external',
    `--outfile=${snapshotPath}`,
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if ((build.status ?? 1) !== 0)
    throw new Error(`Failed to bundle visual diff module ${sourcePath}`)
}

function snapshotVisualDiffConfig(snapshotPath: string) {
  bundleVisualDiffModule(defaultVisualDiffConfigPath, snapshotPath)
}

function snapshotVisualDiffRunner(snapshotPath: string) {
  bundleVisualDiffModule(resolve(repoRoot, 'scripts/visual-diff.ts'), snapshotPath)
}

async function checkoutRef(ref: string) {
  git(['checkout', '--force', ref])
  const install = spawnSync('bun', ['install'], { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if ((install.status ?? 1) !== 0)
    throw new Error(`bun install failed after checkout ${ref}`)
}

async function runPipeline(options: CliOptions) {
  const originalRef = git(['rev-parse', 'HEAD'])
  const baseSha = resolveGitRef(options.baseRef, git(['merge-base', 'HEAD', 'origin/main']))
  const headSha = resolveGitRef(options.headRef, originalRef)
  const visualDiffConfigPath = resolve(outputRoot, `visual-diff-config-${process.pid}.mjs`)
  const visualDiffRunnerPath = resolve(outputRoot, `visual-diff-runner-${process.pid}.mjs`)

  try {
    if (!options.skipGitCheckout && originalRef !== headSha)
      await checkoutRef(headSha)

    snapshotVisualDiffConfig(visualDiffConfigPath)
    const visualDiffConfig = await loadVisualDiffConfig(visualDiffConfigPath)
    snapshotVisualDiffRunner(visualDiffRunnerPath)

    if (!options.skipGitCheckout) {
      await stopFrontendStack()
      await stopBackendStack()
      await checkoutRef(baseSha)
      await captureScreenshots(
        'before',
        options.routes,
        { forceFrontend: true, forceBackend: true },
        visualDiffConfig,
        visualDiffConfigPath,
        visualDiffRunnerPath,
      )
      await stopFrontendStack()
      await stopBackendStack()
      await checkoutRef(headSha)
    }

    await captureScreenshots(
      'after',
      options.routes,
      {
        forceFrontend: !options.skipGitCheckout,
        forceBackend: !options.skipGitCheckout,
      },
      visualDiffConfig,
      visualDiffConfigPath,
      visualDiffRunnerPath,
    )
    const results = await compareScreenshots(options.thresholdPercent, options.routes, visualDiffConfig)
    const summary = generateReport(results, options.thresholdPercent)

    if (summary.changedCount > 0)
      console.log(`[visual-diff] ${summary.changedCount} route(s) changed`)
    else
      console.log('[visual-diff] no visual differences detected')
  }
  finally {
    if (!options.skipGitCheckout) {
      try {
        const currentRef = git(['rev-parse', 'HEAD'])
        if (currentRef !== originalRef) {
          git(['checkout', '--force', originalRef])
          const install = spawnSync('bun', ['install'], { cwd: repoRoot, stdio: 'inherit', env: process.env })
          if ((install.status ?? 1) !== 0)
            throw new Error(`bun install failed after restoring git ref ${originalRef}`)
        }
      }
      catch (error) {
        console.error(`[visual-diff] failed to restore git ref ${originalRef}:`, error)
      }
    }
    rmSync(visualDiffConfigPath, { force: true })
    rmSync(visualDiffRunnerPath, { force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(outputRoot, { recursive: true })

  try {
    if (options.command === 'capture') {
      await captureScreenshots(options.phase!, options.routes)
      return
    }

    if (options.command === 'capture-route') {
      const { visualDiffRoutes, visualDiffViewport } = await loadVisualDiffConfig()
      const [route] = selectedRoutes(visualDiffRoutes, options.routes)
      if (!route)
        throw new Error('capture-route could not resolve its configured route')
      await captureRouteScreenshot(options.phase!, route, visualDiffViewport)
      return
    }

    if (options.command === 'diff') {
      const results = await compareScreenshots(options.thresholdPercent, options.routes)
      generateReport(results, options.thresholdPercent)
      return
    }

    await runPipeline(options)
  }
  finally {
    await stopAllProcesses()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
