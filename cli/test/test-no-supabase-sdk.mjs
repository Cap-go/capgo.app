#!/usr/bin/env node
// Guard: the CLI talks to Capgo only through Capgo HTTP endpoints. No database SDK,
// no direct PostgREST queries, so the backend can move off Supabase without a CLI release.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {}))
    assert.ok(!name.startsWith('@supabase/'), `${field} must not include ${name}`)
}

const offenders = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walk(path)
      continue
    }
    if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(entry))
      continue
    const source = readFileSync(path, 'utf8')
    if (/from ['"]@supabase\//.test(source) || /\.rpc\(\s*['"]/.test(source))
      offenders.push(path.slice(root.length))
  }
}
walk(join(root, 'src'))
assert.deepEqual(offenders, [], `CLI sources must use Capgo HTTP endpoints, not Supabase: ${offenders.join(', ')}`)

console.log('✅ CLI has no Supabase SDK usage')
