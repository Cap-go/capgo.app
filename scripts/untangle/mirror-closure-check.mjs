#!/usr/bin/env node
// Usage: node scripts/untangle/mirror-closure-check.mjs <git-ref> [basename.ts ...]
import { execFileSync } from 'node:child_process'
import { join, posix } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const REF = process.argv[2] || 'origin/main'
const PLUGIN_DIR = 'supabase/functions/_backend/plugin_runtime/utils'
const BACKEND_DIR = 'supabase/functions/_backend/utils'

/** Read a file at ref from git without invoking a shell. */
function gitShow(repoPath) {
  return execFileSync('git', ['show', `${REF}:${repoPath}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })
}

/** True when plugin_runtime and _backend copies of basename are byte-identical at ref. */
function bytesMatch(basename) {
  const a = `${PLUGIN_DIR}/${basename}`
  const b = `${BACKEND_DIR}/${basename}`
  try {
    return gitShow(a) === gitShow(b)
  }
  catch {
    return false
  }
}

/** Resolve a relative import from a utils basename to another basename under utils/. */
function resolveRelativeImport(fromBasename, rel) {
  const fromDir = posix.dirname(fromBasename)
  const joined = posix.normalize(posix.join(fromDir === '.' ? '' : fromDir, rel))
  if (joined.startsWith('..') || posix.isAbsolute(joined))
    return null
  return joined.endsWith('.ts') ? joined : `${joined}.ts`
}

/** Collect runtime relative import targets (static, re-export, dynamic); skips import type. */
function parseRuntimeRelativeImports(source) {
  const paths = new Set()
  const blocks = [
    ...(source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm) || []),
    ...(source.match(/^\s*import\s+['"][^'"]+['"]\s*;?/gm) || []),
    ...(source.match(/^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"]\s*;?/gm) || []),
    ...(source.match(/import\s*\(\s*['"][^'"]+['"]\s*\)/g) || []),
  ]
  const relPattern = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/
  for (const block of blocks) {
    if (/^\s*import\s+type\s+/m.test(block))
      continue
    const m = block.match(relPattern)
    const rel = m?.[1]
    if (rel)
      paths.add(rel)
  }
  return [...paths]
}

/** Depth-first runtime dependency basenames reachable from basename in one utils tree. */
function closureBasenames(basename, visited, side) {
  const dir = side === 'plugin' ? PLUGIN_DIR : BACKEND_DIR
  const sourcePath = `${dir}/${basename}`
  if (visited.has(`${side}:${basename}`))
    return []
  visited.add(`${side}:${basename}`)

  let source
  try {
    source = gitShow(sourcePath)
  }
  catch {
    return []
  }

  const rels = parseRuntimeRelativeImports(source)
  const all = [basename]
  for (const rel of rels) {
    const dep = resolveRelativeImport(basename, rel)
    if (!dep)
      continue
    all.push(...closureBasenames(dep, visited, side))
  }
  return all
}

/** Classify one mirror candidate for safe one-line re-export. */
function analyze(basename) {
  const selfMatch = bytesMatch(basename)
  const pluginVisited = new Set()
  const backendVisited = new Set()
  const pluginReach = [...new Set(closureBasenames(basename, pluginVisited, 'plugin'))]
  const backendReach = [...new Set(closureBasenames(basename, backendVisited, 'backend'))]
  const runtimeClosure = [...new Set([...pluginReach, ...backendReach])]
    .filter(f => f !== basename)
    .sort()

  const drifted = []
  for (const dep of [basename, ...runtimeClosure]) {
    if (!bytesMatch(dep))
      drifted.push(dep)
  }

  return {
    file: basename,
    selfByteIdentical: selfMatch,
    runtimeClosure,
    driftedInClosure: [...new Set(drifted)].sort(),
    safeReExport: drifted.length === 0,
  }
}

const candidates = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      'channelSelfRateLimit.ts',
      'deviceComparison.ts',
      'downloadUrl.ts',
      'geolocation.ts',
      'manifest_encoding.ts',
      'queryHelpers.ts',
      'rateLimitInfo.ts',
      'rollout.ts',
      'statsInsights.ts',
      'supabase_write_guard.ts',
      'version_manifest_sql.ts',
    ]

const rows = candidates.map(analyze)
console.log(JSON.stringify({ ref: REF, rows }, null, 2))
