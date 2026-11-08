#!/usr/bin/env bun
/**
 * Emit skeleton outlines (signatures + exports) for large TS areas.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const OUT = join(ROOT, '.context/untangle/skeleton')

const ROOTS = [
  'supabase/functions/_backend/plugin_runtime',
  'supabase/functions/_backend/utils',
  'src/services',
  'src/stores',
  'cli/src',
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules')
      continue
    const p = join(dir, name)
    if (!statSync(p).isDirectory()) {
      if (p.endsWith('.ts') && !p.endsWith('.test.ts'))
        acc.push(p)
    }
    else walk(p, acc)
  }
  return acc
}

function skeletonize(text) {
  const lines = text.split('\n')
  const out = []
  let depth = 0
  for (const line of lines) {
    const t = line.trim()
    if (
      /^(export\s+)?(async\s+)?function\s/.test(t) ||
      /^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(t) ||
      /^(export\s+)?(type|interface)\s/.test(t) ||
      /^export\s+\{/.test(t) ||
      /^import\s/.test(t) ||
      /^export\s+default/.test(t)
    ) {
      if (/\{$/.test(t) || /\)\s*\{$/.test(t) || /=>\s*\{$/.test(t)) {
        out.push(`${line.replace(/\{\s*$/, '{ /* ... */ }')}`)
        depth++
        continue
      }
      out.push(line)
      continue
    }
    if (depth > 0 && /^}/.test(t)) {
      depth--
      if (depth === 0)
        out.push('}')
    }
  }
  return out.join('\n')
}

mkdirSync(OUT, { recursive: true })
let count = 0
for (const r of ROOTS) {
  const dir = join(ROOT, r)
  for (const file of walk(dir)) {
    const rel = relative(ROOT, file)
    const skel = skeletonize(readFileSync(file, 'utf8'))
    const outPath = join(OUT, rel.replace(/\//g, '__'))
    writeFileSync(outPath, skel)
    count++
  }
}
console.log(JSON.stringify({ skeletonFiles: count, outDir: relative(ROOT, OUT) }))
