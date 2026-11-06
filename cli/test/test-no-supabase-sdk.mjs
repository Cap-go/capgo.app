#!/usr/bin/env node
// Guard: the CLI talks to Capgo only through Capgo HTTP endpoints. No database SDK,
// no Supabase hosts, URLs, flags or generated database types, so the backend can
// move off Supabase without a CLI release.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {}))
    assert.ok(!name.startsWith('@supabase/'), `${field} must not include ${name}`)
}

// SDK imports in any form, `.rpc(` calls, Supabase URL layouts, the removed
// --supa-host / --supa-anon aliases, and any other mention of Supabase.
const forbidden = [
  /\b(?:from|import)\s*['"]@supabase\//,
  /\bimport\s*\(\s*['"`]@supabase\//,
  /\brequire\s*\(\s*['"`]@supabase\//,
  /\.rpc\s*\(/,
  /supabase/i,
  /\bsupa(?:Host|Anon)\b/,
  /--supa-/,
  /\/(?:rest|functions|storage|auth)\/v1\b/,
]

const offenders = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path)
      continue
    }
    if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry))
      continue
    const source = readFileSync(path, 'utf8')
    const hit = forbidden.find(pattern => pattern.test(source))
    if (hit)
      offenders.push(`${relative(root, path)} (${hit})`)
  }
}
walk(join(root, 'src'))
assert.deepEqual(offenders, [], `CLI sources must use Capgo HTTP endpoints, not Supabase: ${offenders.join(', ')}`)

console.log('✅ CLI sources do not use Supabase')
