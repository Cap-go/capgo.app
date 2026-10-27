#!/usr/bin/env bun
/**
 * Report the console bundle cost a visitor pays, from a Vite build manifest.
 *
 *   bunx vite build --manifest --outDir <dir>
 *   bun scripts/perf/bundle-stats.ts <dir> [--json out.json] [--compare before.json]
 *
 * "Initial" is what index.html loads before the first paint (entry chunk, its
 * static imports and its CSS). Each route adds its page chunk, its layouts, the
 * components App.vue always mounts, and their static imports. Chunks a page
 * loads later on demand (e.g. Chart.js) are not counted.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

type Manifest = Record<string, ManifestChunk>

interface Size {
  files: number
  raw: number
  gzip: number
  brotli: number
}

type Report = Record<string, { js: Size, css: Size }>

const args = process.argv.slice(2)
const outDir = args.find(arg => !arg.startsWith('--')) ?? 'dist'
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined
const compareWith = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : undefined

const manifest: Manifest = JSON.parse(readFileSync(path.join(outDir, '.vite/manifest.json'), 'utf8'))
const sizeCache = new Map<string, Omit<Size, 'files'>>()

function fileSize(file: string) {
  let size = sizeCache.get(file)
  if (!size) {
    const content = readFileSync(path.join(outDir, file))
    size = {
      raw: content.length,
      gzip: gzipSync(content, { level: 9 }).length,
      brotli: brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    }
    sizeCache.set(file, size)
  }
  return size
}

function sum(files: Iterable<string>): Size {
  const total: Size = { files: 0, raw: 0, gzip: 0, brotli: 0 }
  for (const file of files) {
    const size = fileSize(file)
    total.files++
    total.raw += size.raw
    total.gzip += size.gzip
    total.brotli += size.brotli
  }
  return total
}

// Static closure of manifest keys: what the browser must fetch before the chunk runs.
function closure(keys: string[]) {
  const js = new Set<string>()
  const css = new Set<string>()
  const seen = new Set<string>()
  const stack = [...keys]
  while (stack.length) {
    const key = stack.pop()!
    if (seen.has(key) || !manifest[key])
      continue
    seen.add(key)
    const chunk = manifest[key]
    js.add(chunk.file)
    chunk.css?.forEach(file => css.add(file))
    stack.push(...(chunk.imports ?? []))
  }
  return { js, css }
}

function findKey(suffix: string) {
  return Object.keys(manifest).find(key => key === suffix || key.endsWith(`/${suffix}`))
}

const entryKey = Object.keys(manifest).find(key => manifest[key].isEntry && key.endsWith('index.html'))!
const initial = closure([entryKey])

// App.vue mounts these through dynamic imports on every page, so every route pays for them.
const startup = ['src/components/Toast.vue', 'src/components/DialogV2.vue', 'src/components/dashboard/SupportUsernamesPrompt.vue']
// The app and settings layouts render inside the default dashboard shell.
const appShell = ['src/layouts/app.vue', 'src/layouts/default.vue']

const routes: Record<string, string[]> = {
  'login': ['src/pages/login.vue', 'src/layouts/naked.vue'],
  'apps (dashboard)': ['src/pages/apps.vue', 'src/layouts/default.vue'],
  'app overview': ['src/pages/app/[app].vue', ...appShell],
  'app bundles': ['src/pages/app/[app].bundles.vue', ...appShell],
  'app channels': ['src/pages/app/[app].channels.vue', ...appShell],
  'app devices': ['src/pages/app/[app].devices.vue', ...appShell],
  'org usage': ['src/pages/settings/organization/Usage.vue', 'src/layouts/settings.vue', 'src/layouts/default.vue'],
}

const report: Report = {
  'initial (index.html)': { js: sum(initial.js), css: sum(initial.css) },
}

for (const [name, files] of Object.entries(routes)) {
  const wanted = [...files, ...startup]
  const keys = wanted.map(findKey).filter((key): key is string => !!key)
  if (keys.length !== wanted.length)
    console.warn(`missing manifest entry for route ${name}: ${files.join(', ')}`)
  const route = closure([entryKey, ...keys])
  report[`route: ${name}`] = { js: sum(route.js), css: sum(route.css) }
}

const allJs = new Set<string>()
const allCss = new Set<string>()
for (const chunk of Object.values(manifest)) {
  if (chunk.file.endsWith('.js'))
    allJs.add(chunk.file)
  chunk.css?.forEach(file => allCss.add(file))
}
report['all chunks'] = { js: sum(allJs), css: sum(allCss) }

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`
const before: Report | undefined = compareWith ? JSON.parse(readFileSync(compareWith, 'utf8')) : undefined

function delta(now: number, then: number | undefined) {
  if (then === undefined || then === 0)
    return ''
  const pct = ((now - then) / then) * 100
  return ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`
}

const lines = ['| Scope | JS files | JS raw | JS gzip | JS brotli | CSS brotli |', '| --- | ---: | ---: | ---: | ---: | ---: |']
for (const [name, { js, css }] of Object.entries(report)) {
  const old = before?.[name]
  lines.push(`| ${name} | ${js.files}${delta(js.files, old?.js.files)} | ${kb(js.raw)}${delta(js.raw, old?.js.raw)} | ${kb(js.gzip)}${delta(js.gzip, old?.js.gzip)} | ${kb(js.brotli)}${delta(js.brotli, old?.js.brotli)} | ${kb(css.brotli)}${delta(css.brotli, old?.css.brotli)} |`)
}
console.log(lines.join('\n'))

if (jsonOut)
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`)
