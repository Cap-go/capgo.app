#!/usr/bin/env node
// Guard: the CLI sources also ship as `@capgo/cli/sdk`, which runs on Cloudflare
// Workers. workerd throws on `redirect: 'error'` before sending the request, so
// fetches that must not follow redirects use `redirect: 'manual'` and treat the
// 3xx as a failed response.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const forbidden = /\bredirect\s*:\s*['"`]error['"`]/

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
    if (forbidden.test(readFileSync(path, 'utf8')))
      offenders.push(relative(root, path))
  }
}
walk(join(root, 'src'))
assert.deepEqual(offenders, [], `use redirect: 'manual' (Cloudflare Workers reject 'error'): ${offenders.join(', ')}`)

console.log('✅ CLI sources never use redirect: \'error\'')
