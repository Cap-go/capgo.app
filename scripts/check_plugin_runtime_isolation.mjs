/**
 * Fail if plugin_runtime imports any sibling _backend module outside itself,
 * or if the CF plugin worker imports non-plugin_runtime backend code.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const runtimeRoot = resolve(root, 'supabase/functions/_backend/plugin_runtime')
const pluginEntry = resolve(root, 'cloudflare_workers/plugin/index.ts')
const backendRoot = resolve(root, 'supabase/functions/_backend')

const errors = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory())
      walk(abs, out)
    else if (entry.name.endsWith('.ts'))
      out.push(abs)
  }
  return out
}

function resolveImport(from, spec) {
  if (!spec.startsWith('.'))
    return null
  const base = resolve(dirname(from), spec)
  for (const cand of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(cand) && cand.endsWith('.ts'))
      return cand
  }
  return null
}

function collectImports(file) {
  const text = readFileSync(file, 'utf8')
  const specs = []
  const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text)))
    specs.push(m[1])
  return specs
}

for (const file of walk(runtimeRoot)) {
  for (const spec of collectImports(file)) {
    const resolved = resolveImport(file, spec)
    if (!resolved)
      continue
    if (resolved.startsWith(`${backendRoot}/`) && !resolved.startsWith(`${runtimeRoot}/`)) {
      errors.push(`${relative(root, file)} imports ${relative(root, resolved)} (outside plugin_runtime)`)
    }
  }
}

for (const spec of collectImports(pluginEntry)) {
  const resolved = resolveImport(pluginEntry, spec)
  if (!resolved)
    continue
  if (resolved.startsWith(`${backendRoot}/`) && !resolved.startsWith(`${runtimeRoot}/`)) {
    errors.push(`cloudflare_workers/plugin/index.ts imports ${relative(root, resolved)} (must use plugin_runtime only)`)
  }
}

const denoEntries = [
  'supabase/functions/updates/index.ts',
  'supabase/functions/stats/index.ts',
  'supabase/functions/channel_self/index.ts',
  'supabase/functions/updates_debug/index.ts',
]

for (const rel of denoEntries) {
  const file = resolve(root, rel)
  for (const spec of collectImports(file)) {
    const resolved = resolveImport(file, spec)
    if (!resolved)
      continue
    // Request-path code must come from plugin_runtime. The only allowed
    // sibling _backend import is none — Deno supabase-js bridge lives in
    // shared/plugin_deno_stats_fallbacks.ts.
    if (resolved.startsWith(`${backendRoot}/`) && !resolved.startsWith(`${runtimeRoot}/`)) {
      errors.push(`${rel} imports ${relative(root, resolved)} (use plugin_runtime or shared Deno bridge)`)
    }
  }
}

if (errors.length) {
  console.error('plugin_runtime isolation check failed:\n')
  for (const err of errors)
    console.error(`- ${err}`)
  process.exit(1)
}

console.log('plugin_runtime isolation check passed')
