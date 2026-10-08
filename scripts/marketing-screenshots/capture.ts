/**
 * Capture the console screenshots used on capgo.app (Cap-go/website).
 *
 *   bun run serve:worktree                      # frontend for this worktree
 *   bun run screenshots:marketing               # seed + capture + export
 *   bun run screenshots:marketing -- observe-   # only shots whose name starts with "observe-"
 *   bun run screenshots:marketing -- --videos   # also record the looping videos (needs ffmpeg)
 *   bun run screenshots:marketing -- video-     # only the videos
 *
 * Env:
 *   BASE_URL     frontend URL (default http://localhost:5173)
 *   DB_URL       local Postgres, set by `supabase:with-env`; seeding is skipped without it
 *   WEBSITE_DIR  website repo root; webp files are written to apps/web/public/landing-demos
 *   OUT_DIR      raw png + webp output (default .context/marketing-screenshots)
 *
 * Seeds fake demo data into the LOCAL stack only and refuses any non-local database.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { Shot } from './shots'
import type { VideoFlow } from './videos'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'
import { Client } from 'pg'
import { installMocks, maskIdentities } from './mocks'
import { shots } from './shots'
import { CURSOR_SCRIPT, videoFlows } from './videos'

const repoRoot = resolve(import.meta.dir, '../..')
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const outDir = resolve(process.env.OUT_DIR ?? resolve(repoRoot, '.context/marketing-screenshots'))
const websiteDir = process.env.WEBSITE_DIR ? resolve(process.env.WEBSITE_DIR) : null
const filters = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const skipSeed = process.argv.includes('--no-seed')
const withVideos = process.argv.includes('--videos')
const selectedByName = (name: string) => filters.length === 0 || filters.some(filter => name.startsWith(filter))

const HIDE_CHROME_CSS = `
  #__vue-devtools-container__, [id^="vue-devtools"], vite-error-overlay { display: none !important; }
  *, *::before, *::after { caret-color: transparent !important; }
  [data-sonner-toaster], [data-test="getting-started-nav"], [data-test="section-intro"] { display: none !important; }
`

async function seed() {
  const dbUrl = process.env.DB_URL
  if (skipSeed || !dbUrl) {
    console.log(skipSeed ? 'Skipping seed (--no-seed).' : 'DB_URL not set: skipping seed. Run through `bun run screenshots:marketing`.')
    return
  }
  // IPv6 hosts come back bracketed (`[::1]`) from URL.hostname.
  const host = new URL(dbUrl).hostname.replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host))
    throw new Error(`Refusing to seed non-local database host "${host}".`)
  const client = new Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await client.query(readFileSync(resolve(import.meta.dir, 'seed.sql'), 'utf8'))
    console.log('Seeded demo data.')
  }
  finally {
    await client.end()
  }
}

async function settle(page: Page, waitMs: number) {
  await page.addStyleTag({ content: HIDE_CHROME_CSS }).catch(() => {})
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(waitMs)
  // Re-apply: some pages mount their chrome after the first paint.
  await page.addStyleTag({ content: HIDE_CHROME_CSS }).catch(() => {})
}

async function login(page: Page) {
  await page.goto(`${baseUrl}/login/`)
  await page.fill('[data-test="email"]', 'test@capgo.app')
  await page.fill('[data-test="password"]', 'testtest')
  await page.locator('[data-test="submit"]').click()
  await page.waitForURL(/\/(apps|dashboard)(\/|$)/, { timeout: 30_000 })
  await settle(page, 1000)
}

/** Crop, resize, and encode a PNG to webp with Chromium's canvas (no image tooling needed). */
async function encodeWebp(browser: Browser, png: Buffer, exp: NonNullable<Shot['exports']>[number]) {
  const page = await browser.newPage()
  try {
    const dataUrl = await page.evaluate(async ({ src, crop, width, quality }) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const area = crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight }
      const scale = width / area.width
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = Math.round(area.height * scale)
      const ctx = canvas.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/webp', quality)
    }, { src: `data:image/png;base64,${png.toString('base64')}`, crop: exp.crop ?? null, width: exp.width, quality: exp.quality ?? 0.8 })
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  }
  finally {
    await page.close()
  }
}

function writeOutput(file: string, data: Buffer) {
  const targets = [resolve(outDir, 'webp', file)]
  if (websiteDir)
    targets.push(resolve(websiteDir, 'apps/web/public/landing-demos', file))
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}

function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (result.status !== 0)
    throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

/** Record one flow in its own context (video needs it), then trim, fade, and encode mp4 + webm + poster. */
async function recordVideo(browser: Browser, storageState: Awaited<ReturnType<BrowserContext['storageState']>>, flow: VideoFlow) {
  const workDir = mkdtempSync(resolve(tmpdir(), 'capgo-video-'))
  const context = await browser.newContext({
    storageState,
    viewport: flow.viewport,
    colorScheme: 'dark',
    locale: 'en-US',
    timezoneId: 'UTC',
    recordVideo: { dir: workDir, size: flow.viewport },
  })
  await context.addInitScript(CURSOR_SCRIPT)
  const page = await context.newPage()
  const recordingStart = Date.now()
  await installMocks(page)
  await page.goto(baseUrl + flow.path)
  await settle(page, 3000)
  await maskIdentities(page)
  const start = (Date.now() - recordingStart) / 1000
  await flow.run(page)
  const duration = (Date.now() - recordingStart) / 1000 - start
  const video = page.video()
  await context.close()
  const raw = await video!.path()

  const fade = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, duration - 0.4).toFixed(2)}:d=0.4`
  const trim = ['-ss', start.toFixed(2), '-t', duration.toFixed(2), '-i', raw]
  const mp4 = resolve(workDir, 'out.mp4')
  const webm = resolve(workDir, 'out.webm')
  const poster = resolve(workDir, 'poster.png')
  ffmpeg([...trim, '-vf', `fps=30,${fade}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', mp4])
  ffmpeg([...trim, '-vf', `fps=30,${fade}`, '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-an', webm])
  ffmpeg(['-ss', (start + 0.5).toFixed(2), '-i', raw, '-frames:v', '1', poster])

  writeOutput(`${flow.file}.mp4`, readFileSync(mp4))
  writeOutput(`${flow.file}.webm`, readFileSync(webm))
  writeOutput(`${flow.file}-poster.webp`, await encodeWebp(browser, readFileSync(poster), { file: '', width: flow.viewport.width, quality: 0.8 }))
  rmSync(workDir, { recursive: true, force: true })
  console.log(`recorded ${flow.name} (${duration.toFixed(1)}s) -> ${flow.file}.{mp4,webm}`)
}

async function main() {
  const reachable = await fetch(`${baseUrl}/login/`).then(res => res.ok, () => false)
  if (!reachable)
    throw new Error(`Frontend not reachable at ${baseUrl}. Start it with \`bun run serve:worktree\` or set BASE_URL.`)

  await seed()
  mkdirSync(resolve(outDir, 'png'), { recursive: true })

  const browser = await chromium.launch()
  const context = await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC' })
  const page = await context.newPage()
  page.on('pageerror', error => console.warn(`[page error] ${error.message}`))
  await installMocks(page)
  await login(page)

  const selected = shots.filter(shot => selectedByName(shot.name))
  for (const shot of selected) {
    await page.setViewportSize(shot.viewport)
    await page.goto(baseUrl + shot.path)
    await settle(page, 4000)
    await shot.prepare?.(page)
    await maskIdentities(page)
    const png = await page.screenshot()
    writeFileSync(resolve(outDir, 'png', `${shot.name}.png`), png)

    for (const exp of shot.exports ?? [])
      writeOutput(exp.file, await encodeWebp(browser, png, exp))
    console.log(`captured ${shot.name}${shot.exports?.length ? ` -> ${shot.exports.map(exp => exp.file).join(', ')}` : ''}`)
  }

  // Videos run with --videos, or when a filter names them (e.g. `video-`); other filters still apply.
  const wantVideos = withVideos || filters.some(filter => filter.startsWith('video'))
  const flows = wantVideos ? videoFlows.filter(flow => selectedByName(flow.name)) : []
  if (flows.length > 0) {
    const storageState = await context.storageState()
    for (const flow of flows)
      await recordVideo(browser, storageState, flow)
  }

  await browser.close()
  console.log(`Done. Raw captures in ${resolve(outDir, 'png')}${websiteDir ? `, webp written to ${websiteDir}` : ''}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
