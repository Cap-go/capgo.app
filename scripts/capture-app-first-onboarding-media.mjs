import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const baseURL = process.env.CAPGO_MEDIA_BASE_URL ?? 'http://localhost:5173'
const email = process.env.CAPGO_MEDIA_EMAIL ?? `media-onboard-${Date.now()}@example.com`
const password = process.env.CAPGO_MEDIA_PASSWORD ?? `CapgoMedia${Date.now()}!Zx`
const outDir = path.resolve('docs/pr/app-first-onboarding')

function isSafeFileName(name) {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'
}

async function ensureFreshMediaUser(supabaseUrl, anonKey) {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  if (!serviceKey)
    return

  await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: 'Demo', last_name: 'User' },
    }),
  }).catch(() => {})
}

async function signInThroughUi(page, supabaseUrl, anonKey) {
  await ensureFreshMediaUser(supabaseUrl, anonKey)

  await page.goto(`${baseURL}/login`)
  await page.fill('[data-test="email"]', email)
  await page.click('[data-test="continue"]')
  await page.fill('[data-test="password"]', password)
  await page.click('[data-test="submit"]')
  await page.waitForURL(/\/onboarding\/app/, { timeout: 60000 })
}

async function main() {
  await mkdir(outDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    recordVideo: {
      dir: outDir,
      size: { width: 1280, height: 800 },
    },
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  const suffix = Date.now()
  const appName = `Demo App ${suffix}`

  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:55411'
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

  await signInThroughUi(page, supabaseUrl, anonKey)
  await page.goto(`${baseURL}/onboarding/app`)
  await page.waitForURL(/\/onboarding\/app/, { timeout: 60000 })
  await page.waitForSelector('[data-test="onboarding-intent-ota"]', { timeout: 60000 })

  await page.locator('[data-test="onboarding-intent-ota"]').click()
  await page.screenshot({ path: path.join(outDir, '01-intent-step.png'), fullPage: true })
  await page.locator('[data-test="app-onboarding-continue-intent"]').click()

  await page.locator('[data-test="app-onboarding-existing-no"]').click()
  await page.locator('[data-test="app-onboarding-name"]').fill(appName)
  await page.screenshot({ path: path.join(outDir, '02-app-details-filled.png'), fullPage: true })
  await page.locator('[data-test="app-onboarding-continue"]').click()

  await page.locator('[data-test="onboarding-mode-app-name"]').click()
  await page.screenshot({ path: path.join(outDir, '03-organization-step.png'), fullPage: true })
  await page.locator('[data-test="onboarding-create-org"]').click()
  await page.waitForSelector('[data-test="app-onboarding-command-copy"]', { timeout: 60000 })
  await page.screenshot({ path: path.join(outDir, '04-setup-command.png'), fullPage: true })

  await context.close()
  await browser.close()

  convertVideoToWebp()
  console.log(`Saved screenshots, video, and webp under ${outDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

function convertVideoToWebp() {
  const videos = readdirSync(outDir)
    .filter(name => name.endsWith('.webm') && !name.startsWith('.') && isSafeFileName(name))
    .map(name => ({
      name,
      mtime: statSync(path.join(outDir, name)).mtimeMs,
    }))
    .sort((left, right) => right.mtime - left.mtime)

  if (!videos.length)
    return

  const input = path.join(outDir, videos[0].name)
  const output = path.join(outDir, 'app-first-onboarding.webp')
  const framesDir = mkdtempSync(path.join(tmpdir(), 'capgo-onboard-frames-'))
  const framePattern = path.join(framesDir, 'frame_%03d.png')

  try {
    execFileSync('ffmpeg', ['-y', '-i', input, '-vf', 'fps=10,scale=1280:-1', framePattern], { stdio: 'inherit' })
    const frames = readdirSync(framesDir)
      .filter(name => name.endsWith('.png') && isSafeFileName(name))
      .sort()
    if (!frames.length)
      return

    execFileSync('img2webp', ['-o', output, ...frames.map(frame => path.join(framesDir, frame))], { stdio: 'inherit' })
  }
  finally {
    rmSync(framesDir, { recursive: true, force: true })
  }

  for (const video of videos)
    rmSync(path.join(outDir, video.name), { force: true })
}
