/**
 * Renders trial recap Bento HTML fixtures to PNG image files for PR screenshots.
 * Run from repo root: node scripts/render-trial-email-previews.mjs
 * Writes to .github/pr-assets/ (for raw.githubusercontent.com links on the PR branch).
 *
 * Legacy before screenshots read real Bento export HTML from the agent store
 * (not committed): /cursor/stores/bot/trial-legacy-bento/2-43142.html and 3-43141.html
 */
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const legacyBentoDir = '/cursor/stores/bot/trial-legacy-bento'

const fixture = {
  kind: 'trial_usage_recap',
  trial_end_date: '2026-11-20',
  trial_end_date_label: 'November 20, 2026',
  variant: 'usage',
  email_variant: 'usage',
  low_usage_score: 5,
  metrics_start_date: '2025-11-01',
  metrics_end_date: '2025-11-19',
  successful_updates: 4200,
  failed_updates: 12,
  bandwidth_bytes: 1200000000,
  bandwidth_human: '1.12 GB',
  peak_daily_mau: 120,
  bundles_uploaded: 8,
  native_builds_run: 3,
  channels_count: 4,
  apps_count: 2,
  deploy_count: 6,
  show_pay_as_you_go: true,
  plans_url: 'https://capgo.app/settings/organization/plans',
  usage_url: 'https://capgo.app/settings/organization/usage',
  docs_cli_url: 'https://capgo.app/docs/getting-started/onboarding/',
  docs_upload_url: 'https://capgo.app/docs/getting-started/deploy/#uploading-a-bundle',
  docs_channels_url: 'https://capgo.app/docs/live-updates/channels/',
  show_successful_updates: true,
  show_bandwidth: true,
  show_peak_mau: true,
  show_bundles_uploaded: true,
  show_deploy_count: true,
  show_native_builds: true,
  show_channels_count: true,
  show_apps_count: true,
}

const lowFixture = {
  ...fixture,
  kind: 'trial_end_usage_recap',
  variant: 'low_usage',
  email_variant: 'low_usage',
  low_usage_score: 1,
  successful_updates: 0,
  failed_updates: 0,
  bandwidth_bytes: 0,
  bandwidth_human: '0 B',
  peak_daily_mau: 0,
  bundles_uploaded: 0,
  native_builds_run: 0,
  deploy_count: 0,
  channels_count: 0,
  apps_count: 1,
  show_pay_as_you_go: true,
  show_successful_updates: false,
  show_bandwidth: false,
  show_peak_mau: false,
  show_bundles_uploaded: false,
  show_deploy_count: false,
  show_native_builds: false,
  show_channels_count: false,
  show_apps_count: true,
}

function liquidReplace(html, details) {
  let out = html
  for (const [key, val] of Object.entries(details)) {
    const re = new RegExp(`\\{\\{\\s*event\\.details\\.${key}\\s*\\}\\}`, 'g')
    out = out.replace(re, String(val))
  }
  if (details.kind === 'trial_usage_recap') {
    out = out.replace(
      /\{%\s*if\s*event\.details\.kind\s*==\s*'trial_usage_recap'\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
      '$1',
    )
  }
  else {
    out = out.replace(
      /\{%\s*if\s*event\.details\.kind\s*==\s*'trial_usage_recap'\s*%\}([\s\S]*?)\{%\s*else\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
      '$2',
    )
  }
  out = out.replace(
    /\{%\s*if\s*event\.details\.(show_\w+)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g,
    (_m, showKey, inner) => (details[showKey] ? inner : ''),
  )
  return out
}

/** Minimal document wrapper so Playwright lays out email fragments like a narrow viewport. */
function wrapFragment(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${bodyHtml}
</body>
</html>`
}

async function readLegacyFragment(filename) {
  const path = join(legacyBentoDir, filename)
  await access(path)
  const raw = await readFile(path, 'utf8')
  return wrapFragment(raw)
}

async function main() {
  const { chromium } = await import('@playwright/test')
  const usageTpl = await readFile(join(root, 'supabase/templates/bento/trial_usage_recap_usage.html'), 'utf8')
  const lowTpl = await readFile(join(root, 'supabase/templates/bento/trial_usage_recap_low_usage.html'), 'utf8')

  const beforeThreeDaysLeft = await readLegacyFragment('2-43142.html')
  const beforeEndsToday = await readLegacyFragment('3-43141.html')

  const usageHtml = liquidReplace(usageTpl, { ...fixture, email_variant: 'usage' })
  const lowHtml = liquidReplace(lowTpl, { ...lowFixture, email_variant: 'low_usage' })

  const outDir = join(root, '.github', 'pr-assets')
  await mkdir(outDir, { recursive: true })

  const browser = await chromium.launch()
  try {
    for (const [name, html, width] of [
      ['before-bento-3-days-left-desktop.png', beforeThreeDaysLeft, 900],
      ['before-bento-3-days-left-mobile.png', beforeThreeDaysLeft, 375],
      ['before-bento-ends-today-desktop.png', beforeEndsToday, 900],
      ['before-bento-ends-today-mobile.png', beforeEndsToday, 375],
      ['trial-recap-usage-desktop.png', usageHtml, 900],
      ['trial-recap-usage-mobile.png', usageHtml, 375],
      ['trial-recap-low-usage-desktop.png', lowHtml, 900],
      ['trial-recap-low-usage-mobile.png', lowHtml, 375],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } })
      await page.setContent(html, { waitUntil: 'load' })
      await page.screenshot({ path: join(outDir, name), fullPage: true })
      await page.close()
    }
  }
  finally {
    await browser.close()
  }

  const readme = [
    'Email preview PNGs (Playwright; liquid fixture substitution for new templates):',
    'Before (legacy Bento trial emails; HTML from agent store, not in repo):',
    '- before-bento-3-days-left-desktop.png',
    '- before-bento-3-days-left-mobile.png',
    '- before-bento-ends-today-desktop.png',
    '- before-bento-ends-today-mobile.png',
    'After (new Bento templates):',
    '- trial-recap-usage-desktop.png',
    '- trial-recap-usage-mobile.png',
    '- trial-recap-low-usage-desktop.png',
    '- trial-recap-low-usage-mobile.png',
  ].join('\n')
  await writeFile(join(outDir, 'README.txt'), readme)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
