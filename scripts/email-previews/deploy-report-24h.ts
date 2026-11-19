import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { Liquid } from 'liquidjs'

// Local rendering only: no provider credentials, remote requests, or email sends.
const templatePath = process.argv[2] ?? 'supabase/templates/bento/deploy_report_24h.html'
const output = resolve(process.argv[3] ?? '.context/deploy-report-preview')
await mkdir(output, { recursive: true })
const template = await readFile(templatePath, 'utf8')
const body = await new Liquid().parseAndRender(template, {
  visitor: { first_name: 'Alex', unsubscribe_url: 'https://example.com/unsubscribe' },
  event: { details: {
    report_schema_version: '3', app_id: 'com.example.app', app_name: 'Example App',
    version_name: '2.4.0', version_id: '123', channel_id: '456', channel_name: 'production', platform: 'ios',
    window_start: '2026-11-10T12:00:00Z', window_end: '2026-11-11T12:00:00Z',
    install_count_24h: '120', failure_count_24h: '4', install_count_is_estimate: 'true',
  } },
})
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body { margin:0; padding:24px; font:15px/1.55 Arial,sans-serif; color:#17202d; background:#fff; }
main { max-width:640px; margin:auto; } a { color:#2459ca; } li { margin:5px 0; overflow-wrap:anywhere; }
.subject { color:#525d6c; border-bottom:1px solid #dbe1e8; padding-bottom:16px; margin-bottom:24px; }
small { color:#525d6c; } @media(max-width:420px) { body { padding:16px; } }
</style></head><body><main><div class="subject">Your bundle’s first 24h report<br><small>Synthetic preview · not a sent email</small></div>${body}</main></body></html>`
await writeFile(resolve(output, 'preview.html'), html)
const browser = await chromium.launch()
try {
  for (const [name, width] of [['desktop', 760], ['mobile', 390]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
    await page.route('**/*', route => route.abort())
    await page.setContent(html, { waitUntil: 'load' })
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
      throw new Error(`Horizontal overflow: ${name}`)
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true })
    await page.close()
  }
}
finally {
  await browser.close()
}
console.log(`Rendered synthetic previews to ${output}`)
