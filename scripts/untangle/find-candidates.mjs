#!/usr/bin/env node
/**
 * Heuristic scan for untangle decision-log candidates (file:line).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const ROOTS = [
  'supabase/functions/_backend',
  'src',
  'cli/src',
  'cloudflare_workers',
]

const SKIP = new Set(['node_modules', 'dist', '.context'])

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name))
      continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory())
      walk(p, acc)
    else if (/\.(ts|vue|tsx)$/.test(name) && !/\.d\.ts$/.test(name))
      acc.push(p)
  }
  return acc
}

const files = []
for (const r of ROOTS)
  walk(join(ROOT, r), files)

const patterns = [
  { cat: 'special', re: /catch\s*\([^)]*\)\s*\{[^}]*\}/, label: 'compact catch' },
  { cat: 'special', re: /catch\s*\{/, label: 'catch omit binding' },
  { cat: 'special', re: /setTimeout|sleep\(|delay\(|Bun\.sleep/, label: 'sleep/delay' },
  { cat: 'special', re: /retry|MAX_.*RETRY|attempts/i, label: 'retry' },
  { cat: 'special', re: /if\s*\([^)]*platform.*admin|is_platform_admin|isPlatformAdmin/i, label: 'platform admin branch' },
  { cat: 'special', re: /plugin_version|isDeprecatedPluginVersion/, label: 'plugin version branch' },
  { cat: 'surplus', re: /^export \{[^}]+\} from/m, label: 're-export' },
  { cat: 'needless', re: /from ['\"]\.\.\/utils\/utils/, label: 'utils god import' },
]

const hits = []
for (const file of files) {
  const rel = relative(ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line))
        hits.push({ cat: p.cat, rel, line: i + 1, label: p.label, text: line.trim().slice(0, 120) })
    }
  })
}

const byCat = {}
for (const h of hits) {
  byCat[h.cat] = (byCat[h.cat] ?? 0) + 1
}
console.log(JSON.stringify({ byCat, sample: hits.slice(0, 200) }, null, 2))
