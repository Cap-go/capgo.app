#!/usr/bin/env bun
/**
 * Approximate file co-change frequency from git history (last 500 commits).
 */
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const FOCUS_PREFIXES = [
  'supabase/functions/_backend/utils/',
  'supabase/functions/_backend/plugin_runtime/',
  'supabase/functions/_backend/plugins/',
  'supabase/functions/_backend/public/',
  'supabase/functions/_backend/private/',
  'src/services/',
  'src/stores/',
  'cli/src/',
]

function pairsFromCommit(files) {
  const focused = files.filter(f => FOCUS_PREFIXES.some(p => f.startsWith(p)))
  const pairs = new Map()
  for (let i = 0; i < focused.length; i++) {
    for (let j = i + 1; j < focused.length; j++) {
      const a = focused[i] < focused[j] ? focused[i] : focused[j]
      const b = focused[i] < focused[j] ? focused[j] : focused[i]
      const key = `${a}|${b}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
    }
  }
  return pairs
}

const log = execSync(
  'git log -500 --pretty=format:%H --name-only',
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
)

const commits = log.split(/\n(?=[0-9a-f]{40}$)/m)
const aggregate = new Map()
const fileTouch = new Map()

for (const block of commits) {
  const lines = block.trim().split('\n').filter(Boolean)
  if (lines.length < 2)
    continue
  const files = lines.slice(1).filter(f => f.endsWith('.ts') || f.endsWith('.vue'))
  for (const f of files)
    fileTouch.set(f, (fileTouch.get(f) ?? 0) + 1)
  for (const [k, v] of pairsFromCommit(files))
    aggregate.set(k, (aggregate.get(k) ?? 0) + v)
}

const topPairs = [...aggregate.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .map(([key, count]) => {
    const [a, b] = key.split('|')
    return { count, a, b }
  })

const topFiles = [...fileTouch.entries()]
  .filter(([f]) => FOCUS_PREFIXES.some(p => f.startsWith(p)))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .map(([file, count]) => ({ file, count }))

console.log(JSON.stringify({ topPairs, topFiles }, null, 2))
