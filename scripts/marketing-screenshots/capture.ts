/**
 * Capture the console screenshots used on capgo.app (Cap-go/website).
 *
 *   bun run serve:worktree                      # frontend for this worktree
 *   bun run screenshots:marketing               # seed + capture + export
 *   bun run screenshots:marketing -- observe-   # only shots whose name starts with "observe-"
 *
 * Env:
 *   BASE_URL     frontend URL (default http://localhost:5173)
 *   DB_URL       local Postgres, set by `supabase:with-env`; seeding is skipped without it
 *   WEBSITE_DIR  website repo root; webp files are written to apps/web/public/landing-demos
 *   OUT_DIR      raw PNG + webp output (default .context/marketing-screenshots)
 *
 * Seeds fake demo data into the LOCAL stack only and refuses any non-local database.
 */
import type { Browser, Page } from '@playwright/test'
import type { Shot } from './shots'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'
import { Client } from 'pg'
import { installMocks, maskIdentities } from './mocks'
import { shots } from './shots'

const repoRoot = resolve(import.meta.dir, '../..')
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const outDir = resolve(process.env.OUT_DIR ?? resolve(repoRoot, '.context/marketing-screenshots'))
const websiteDir = process.env.WEBSITE_DIR ? resolve(process.env.WEBSITE_DIR) : null
const filters = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const skipSeed = process.argv.includes('--no-seed')

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
  const host = new URL(dbUrl).hostname
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

  const selected = shots.filter(shot => filters.length === 0 || filters.some(filter => shot.name.startsWith(filter)))
  for (const shot of selected) {
    await page.setViewportSize(shot.viewport)
    await page.goto(baseUrl + shot.path)
    await settle(page, 4000)
    await shot.prepare?.(page)
    await maskIdentities(page)
    const png = await page.screenshot()
    writeFileSync(resolve(outDir, 'png', `${shot.name}.png`), png)

    for (const exp of shot.exports ?? []) {
      const webp = await encodeWebp(browser, png, exp)
      const targets = [resolve(outDir, 'webp', exp.file)]
      if (websiteDir)
        targets.push(resolve(websiteDir, 'apps/web/public/landing-demos', exp.file))
      for (const target of targets) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, webp)
      }
    }
    console.log(`captured ${shot.name}${shot.exports?.length ? ` -> ${shot.exports.map(exp => exp.file).join(', ')}` : ''}`)
  }

  await browser.close()
  console.log(`Done. PNGs in ${resolve(outDir, 'png')}${websiteDir ? `, webp written to ${websiteDir}` : ''}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
