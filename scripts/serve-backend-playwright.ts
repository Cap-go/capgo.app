import type { SupabaseStatus } from './supabase-worktree-status'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process, { env } from 'node:process'
import { getPlaywrightStripeApiBaseUrl } from './playwright-stripe'
import { getSupabaseWorktreeConfig } from './supabase-worktree-config'
import { getSupabaseStatus } from './supabase-worktree-status'

// Browser password-reset tests exercise real delivery to the local mailbox.
env.CONSOLE_LOCAL_SMTP = 'true'

const repoRoot = process.cwd()
const sourceEnvPath = resolve(repoRoot, 'supabase/functions/.env')
const generatedEnvPath = resolve(repoRoot, '.context/playwright/supabase-functions.playwright.env')
const supabaseConfig = getSupabaseWorktreeConfig(repoRoot)

const stripeApiBaseUrl = getPlaywrightStripeApiBaseUrl(env)
const webAppUrl = env.WEBAPP_URL || 'http://localhost:5173'
const functionsReadyTimeoutMs = Number(env.PLAYWRIGHT_BACKEND_TIMEOUT_MS || '360000')
// Comma-separated Supabase services to skip (`supabase start -x`). CI skips the ones E2E
// never touches so a cold runner pulls fewer images before the stack is healthy.
const supabaseStartExclude = env.PLAYWRIGHT_SUPABASE_EXCLUDE?.split(',').filter(service => !['mailpit', 'inbucket'].includes(service.trim())).join(',')

function upsertEnvValue(content: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`^${escapedKey}=.*$`, 'm')
  const line = `${key}=${value}`

  if (matcher.test(content))
    return content.replace(matcher, line)

  return content.endsWith('\n') || content.length === 0
    ? `${content}${line}\n`
    : `${content}\n${line}\n`
}

const baseEnv = existsSync(sourceEnvPath) ? readFileSync(sourceEnvPath, 'utf8') : ''
const overriddenEnv = [
  ['S3_ENDPOINT', `127.0.0.1:${supabaseConfig.ports.api}/storage/v1/s3`],
  ['STRIPE_SECRET_KEY', env.STRIPE_SECRET_KEY || 'sk_test_emulator'],
  ['STRIPE_API_BASE_URL', stripeApiBaseUrl],
  ['STRIPE_WEBHOOK_SECRET', env.STRIPE_WEBHOOK_SECRET || 'testsecret'],
  ['WEBAPP_URL', webAppUrl],
  ['ENV_NAME', 'capgo-api-local'],
  ['CONSOLE_AUTH_E2E', 'true'],
  ['CONSOLE_AUTH_URL', `http://127.0.0.1:${supabaseConfig.ports.api}/functions/v1`],
  ['CONSOLE_REQUIRE_EMAIL_VERIFICATION', 'false'],
  ['BETTER_AUTH_SECRET', 'local-console-auth-development-secret-32-characters'],
  ['JWT_SECRET', 'super-secret-jwt-token-with-at-least-32-characters-long'],
  ['CONSOLE_SMTP_URL', `smtp://supabase_inbucket_${supabaseConfig.projectId}:1025`],
] as const

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hasHealthySupabaseApi(status: SupabaseStatus | null) {
  return Boolean(
    status?.API_URL
    && (status?.ANON_KEY || status?.PUBLISHABLE_KEY)
    && (status?.SERVICE_ROLE_KEY || status?.SECRET_KEY),
  )
}

function stopSupabase() {
  spawnSync('bun', ['run', 'supabase:stop'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
}

function stopExistingPlaywrightBackend() {
  spawnSync('pkill', ['-f', 'supabase-functions.playwright.env'], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: process.env,
  })
}

async function resetSupabaseDb() {
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resetResult = spawnSync('bun', ['run', 'supabase:db:reset'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    })

    if ((resetResult.status ?? 1) === 0)
      return

    stopSupabase()

    if (attempt === maxAttempts)
      process.exit(resetResult.status ?? 1)

    await sleep(attempt * 2000)
    await ensureSupabaseStarted()
  }
}

async function ensureSupabaseStarted() {
  const maxAttempts = 4

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (hasHealthySupabaseApi(getSupabaseStatus()))
      return

    const startResult = spawnSync('bun', ['run', 'supabase:start', ...(supabaseStartExclude ? ['-x', supabaseStartExclude] : [])], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    })

    if ((startResult.status ?? 1) === 0 && hasHealthySupabaseApi(getSupabaseStatus()))
      return

    stopSupabase()

    if (attempt === maxAttempts)
      process.exit(startResult.status ?? 1)

    await sleep(attempt * 2000)
  }
}

async function waitForFunctionsReady(timeoutMs: number) {
  const apiUrl = getSupabaseStatus()?.API_URL || `http://127.0.0.1:${supabaseConfig.ports.api}`
  const targetUrl = `${apiUrl}/functions/v1/ok`
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(targetUrl)
      if (response.ok)
        return
    }
    catch {
      // Keep polling until the edge runtime serves requests again.
    }

    await sleep(1000)
  }

  throw new Error(`Timed out waiting for Supabase functions at ${targetUrl}`)
}

async function stopChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null)
    return

  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })

  child.kill(signal)
  await Promise.race([
    exitPromise,
    sleep(5000).then(() => {
      if (child.exitCode === null)
        child.kill('SIGKILL')
      return exitPromise
    }),
  ])
}

let envFileContent = baseEnv
for (const [key, value] of overriddenEnv)
  envFileContent = upsertEnvValue(envFileContent, key, value)

mkdirSync(dirname(generatedEnvPath), { recursive: true })
writeFileSync(generatedEnvPath, envFileContent)

stopExistingPlaywrightBackend()
await ensureSupabaseStarted()

// Playwright E2E expects the seeded schema helpers and deterministic fixture data.
if (!env.SKIP_SUPABASE_DB_RESET) {
  await resetSupabaseDb()
  await ensureSupabaseStarted()
}

const child = spawn('bun', ['scripts/supabase-worktree.ts', 'functions', 'serve', '--env-file', generatedEnvPath], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

let childStarted = false

try {
  await waitForFunctionsReady(functionsReadyTimeoutMs)
  childStarted = true
}
finally {
  if (!childStarted)
    await stopChildProcess(child)
}

if (env.PLAYWRIGHT_READY_FILE) {
  mkdirSync(dirname(env.PLAYWRIGHT_READY_FILE), { recursive: true })
  writeFileSync(env.PLAYWRIGHT_READY_FILE, 'ready\n')
}

const signalHandlers = new Map<NodeJS.Signals, () => void>()

function forwardSignal(signal: NodeJS.Signals) {
  const handler = () => {
    child.kill(signal)
  }
  signalHandlers.set(signal, handler)
  process.on(signal, handler)
}

forwardSignal('SIGINT')
forwardSignal('SIGTERM')

child.on('exit', (code, signal) => {
  if (signal) {
    for (const [registeredSignal, handler] of signalHandlers)
      process.off(registeredSignal, handler)
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
