#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')
const REF = process.argv[2] || 'origin/main'
const PLUGIN_DIR = 'supabase/functions/_backend/plugin_runtime/utils'
const BACKEND_DIR = 'supabase/functions/_backend/utils'

function gitShow(path) {
  return execSync(`git show ${REF}:${path}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
}

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

function parseRuntimeRelativeImports(source) {
  const paths = new Set()
  const importBlocks = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm) || []
  const sideEffects = source.match(/^\s*import\s+['"][^'"]+['"]\s*;?/gm) || []
  for (const block of [...importBlocks, ...sideEffects]) {
    if (/^\s*import\s+type\s+/m.test(block))
      continue
    const m = block.match(/from\s+['"](\.\/[^'"]+)['"]/) || block.match(/import\s+['"](\.\/[^'"]+)['"]/)
    const rel = m?.[1]
    if (!rel)
      continue
    let name = rel.replace(/^\.\//, '')
    if (!name.endsWith('.ts'))
      name = `${name}.ts`
    paths.add(name)
  }
  return [...paths]
}

function closureBasenames(basename, visited, side) {
  const dir = side === 'plugin' ? PLUGIN_DIR : BACKEND_DIR
  const sourcePath = `${dir}/${basename}`
  if (visited.has(basename))
    return []
  visited.add(basename)

  let source
  try {
    source = gitShow(sourcePath)
  }
  catch {
    return []
  }

  const rels = parseRuntimeRelativeImports(source)
  const all = [basename]
  for (const dep of rels) {
    all.push(...closureBasenames(dep, visited, side))
  }
  return all
}

function analyze(basename) {
  const selfMatch = bytesMatch(basename)
  const pluginVisited = new Set()
  const runtimeClosure = [...new Set(closureBasenames(basename, pluginVisited, 'plugin'))]
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
