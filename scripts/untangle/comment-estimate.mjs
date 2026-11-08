#!/usr/bin/env node
/**
 * Rough count of likely restating line comments in focus areas.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const AREAS = [
  'supabase/functions/_backend/plugin_runtime',
  'supabase/functions/_backend/utils',
  'supabase/functions/_backend/public',
  'supabase/functions/_backend/private',
  'src',
  'cli/src',
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules')
      continue
  if (statSync(p).isDirectory())
      walk(p, acc)
    else if (/\.(ts|vue)$/.test(name))
      acc.push(p)
  }
  return acc
}

let restating = 0
let kept = 0
let total = 0

function norm(s) {
  return s.replace(/[^\w]/g, '').toLowerCase()
}

for (const area of AREAS) {
  for (const file of walk(join(ROOT, area))) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (!t.startsWith('//'))
        continue
      total++
      const body = t.slice(2).trim()
      const next = (lines[i + 1] || '').trim()
      const nBody = norm(body)
      const nNext = norm(next)
      if (
        nNext &&
        (nNext.includes(nBody.slice(0, Math.min(12, nBody.length))) ||
          nBody.includes(nNext.slice(0, 12)))
      )
        restating++
      else if (/workaround|HACK|TODO|must not|oracle|snippet|hyperdrive|replica|RLS/i.test(body))
        kept++
    }
  }
}

console.log(JSON.stringify({ totalLineComments: total, estimatedRestating: restating, likelyExternalContext: kept }))
