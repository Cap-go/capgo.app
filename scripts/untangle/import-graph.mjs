#!/usr/bin/env bun
/**
 * Build a simple ES/TS import dependency summary for untangle analysis.
 * Scans src/, cli/, supabase/functions/_backend (excludes tests in separate roots).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, extname, normalize } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')

const SCAN_ROOTS = [
  'src',
  'cli/src',
  'supabase/functions/_backend',
  'cloudflare_workers',
]

const EXT = new Set(['.ts', '.tsx', '.vue', '.js', '.mjs'])

const IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  }
  catch {
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git')
      continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory())
      walk(p, acc)
    else if (EXT.has(extname(name)))
      acc.push(p)
  }
  return acc
}

function resolveImport(fromFile, spec) {
  if (spec.startsWith('~/'))
    return normalize(join(ROOT, 'src', spec.slice(2)))
  if (spec.startsWith('@/'))
    return normalize(join(ROOT, 'src', spec.slice(2)))
  if (spec.startsWith('.'))
    return normalize(join(dirname(fromFile), spec))
  return null
}

function addEdge(graph, from, to) {
  if (!graph.has(from))
    graph.set(from, new Set())
  graph.get(from).add(to)
}

const files = []
for (const r of SCAN_ROOTS)
  walk(join(ROOT, r), files)

const graph = new Map()
const crossRoot = {
  'src->backend': 0,
  'cli->backend': 0,
  'backend->plugin_runtime_dup': 0,
  'plugin_runtime->backend_utils_dup': 0,
}

for (const file of files) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[1]
    const resolved = resolveImport(file, spec)
    if (!resolved)
      continue
    let target = resolved
    for (const tryExt of ['', '.ts', '.tsx', '.vue', '/index.ts']) {
      try {
        const p = tryExt ? target + tryExt : target
        statSync(p)
        target = p
        break
      }
      catch { /* next */ }
    }
    const targetRel = relative(ROOT, target)
    if (!targetRel.startsWith('..'))
      addEdge(graph, rel, targetRel)

    if (rel.startsWith('src/') && targetRel.startsWith('supabase/'))
      crossRoot['src->backend']++
    if (rel.startsWith('cli/') && targetRel.startsWith('supabase/'))
      crossRoot['cli->backend']++
    if (
      rel.includes('plugin_runtime/utils/') &&
      targetRel.includes('_backend/utils/') &&
      !targetRel.includes('plugin_runtime')
    )
      crossRoot['plugin_runtime->backend_utils_dup']++
    if (
      rel.includes('_backend/') &&
      !rel.includes('plugin_runtime') &&
      targetRel.includes('plugin_runtime/utils/')
    )
      crossRoot['backend->plugin_runtime_dup']++
  }
}

const outDegree = [...graph.entries()]
  .map(([k, v]) => [k, v.size])
  .sort((a, b) => b[1] - a[1])

const inCount = new Map()
for (const [, targets] of graph) {
  for (const t of targets) {
    inCount.set(t, (inCount.get(t) ?? 0) + 1)
  }
}
const inDegree = [...inCount.entries()].sort((a, b) => b[1] - a[1])

const dupBasenames = new Map()
for (const f of files) {
  const base = f.split('/').pop()
  if (!dupBasenames.has(base))
    dupBasenames.set(base, [])
  dupBasenames.get(base).push(relative(ROOT, f))
}
const duplicateFiles = [...dupBasenames.entries()]
  .filter(([, paths]) => paths.length > 1 && paths.some(p => p.includes('plugin_runtime')) && paths.some(p => p.includes('_backend')))
  .map(([name, paths]) => ({ name, paths }))
  .sort((a, b) => b.paths.length - a.paths.length)

const summary = {
  scannedFiles: files.length,
  edges: [...graph.values()].reduce((n, s) => n + s.size, 0),
  crossRoot,
  topOutDegree: outDegree.slice(0, 25),
  topInDegree: inDegree.slice(0, 25),
  duplicateBasenamesAcrossLayers: duplicateFiles.slice(0, 40),
}

console.log(JSON.stringify(summary, null, 2))
