import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { getAuthHeaders, getSupabaseClient, ORG_ID } from '../../tests/test-utils.ts'

// Runs the real Hono handler, JWT middleware and Postgres/RLS paths locally.
// Compare with: bun scripts/supabase-worktree.ts with-env bun scripts/bench/onboarding_progress.mjs <base-commit>
const base = process.argv[2]
assert(base, 'Pass the baseline commit to compare with the working tree')
for (const key of ['SUPABASE_URL', 'SUPABASE_DB_URL']) {
  assert(process.env[key], `Missing ${key}`)
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env[key]).hostname), 'Local services only')
}
const sourcePath = 'supabase/functions/_backend/private/onboarding_progress.ts'
const source = readFileSync(sourcePath, 'utf8')
const beforeSource = execFileSync('git', ['show', `${base}:${sourcePath}`], { encoding: 'utf8' })
assert.notEqual(source, beforeSource, 'Baseline and working tree handlers must differ')
const suffix = randomUUID().replaceAll('-', '')
const modulePaths = ['before', 'after'].map(side => `${sourcePath.replace(/\.ts$/, '')}.bench_${side}_${suffix}.ts`)
const admin = getSupabaseClient()
const appId = `com.test.onboarding.benchmark.${suffix}`
const bindings = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL'].map(key => [key, process.env[key]]))
const results = { baseline: base, runtime: `Bun ${Bun.version}`, samples: 9, requestsPerSample: 10, errors: 0, cases: {} }
const originalQuery = pg.Client.prototype.query
let activePermissions
pg.Client.prototype.query = function (...args) {
  const query = args[0]
  const text = typeof query === 'string' ? query : query.text
  const values = typeof query === 'string' ? args[1] : query.values ?? args[1]
  if (activePermissions && text?.includes('SELECT public.rbac_check_permission_direct(')) {
    const permission = values?.[0]
    activePermissions[permission] = (activePermissions[permission] ?? 0) + 1
  }
  return originalQuery.apply(this, args)
}

function stats(values) {
  const sorted = values.toSorted((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), samples: values }
}

try {
  writeFileSync(modulePaths[0], beforeSource)
  writeFileSync(modulePaths[1], source)
  const handlers = {
    before: (await import(new URL(`../../${modulePaths[0]}`, import.meta.url).href)).app,
    after: (await import(new URL(`../../${modulePaths[1]}`, import.meta.url).href)).app,
  }
  assert.equal((await admin.from('apps').insert({ app_id: appId, owner_org: ORG_ID, name: 'Onboarding benchmark', icon_url: '' })).error, null)
  const onboarding = { setup: { todo_list_version: 3, steps: {} } }
  assert.equal((await admin.from('apps').update({ onboarding }).eq('app_id', appId)).error, null)
  const headers = { ...await getAuthHeaders(), 'Content-Type': 'application/json' }

  for (const [name, N, initial, beforeReads] of [['channel_poll', 0, false, 2], ['bundle_poll', 2, false, 2], ['initial_load', 0, true, 3]]) {
    const expectedBody = { onboarding, ...(N === 0 ? { hasChannel: false } : {}), checkErrors: [] }
    const body = JSON.stringify({ appId, N, initial })
    const samples = { before: [], after: [] }
    const permissions = {}
    async function request(side) {
      activePermissions = {}
      const started = performance.now()
      try {
        const response = await handlers[side].request('http://local/', { method: 'POST', headers, body }, bindings)
        const responseBody = await response.json()
        const elapsed = performance.now() - started
        assert.equal(response.status, 200)
        assert.deepEqual(responseBody, expectedBody)
        assert.equal(activePermissions['app.read'], side === 'before' ? beforeReads : 1)
        if (initial) {
          assert.equal(activePermissions['app.read_devices'], 1)
          assert.equal(activePermissions['app.read_logs'], 1)
        }
        if (permissions[side])
          assert.deepEqual(activePermissions, permissions[side])
        permissions[side] = activePermissions
        return elapsed
      }
      catch (error) {
        results.errors++
        throw error
      }
      finally {
        activePermissions = undefined
      }
    }
    for (let warmup = 0; warmup < 5; warmup++) {
      await request('before')
      await request('after')
    }
    for (let sample = 0; sample < results.samples; sample++) {
      const elapsed = { before: 0, after: 0 }
      for (let index = 0; index < results.requestsPerSample; index++) {
        const order = (sample + index) % 2 === 0 ? ['before', 'after'] : ['after', 'before']
        for (const side of order)
          elapsed[side] += await request(side)
      }
      for (const side of ['before', 'after'])
        samples[side].push(elapsed[side] / results.requestsPerSample)
    }
    results.cases[name] = { beforeMs: stats(samples.before), afterMs: stats(samples.after), permissionQueriesPerRequest: permissions }
  }
  // Every new request must authorize again, even after successful observations.
  assert.equal((await handlers.after.request('http://local/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId, N: 0 }) }, bindings)).status, 401)
  assert.equal((await admin.from('apps').select('onboarding').eq('app_id', appId).single()).data?.onboarding.setup.todo_list_version, 3)
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
}
finally {
  pg.Client.prototype.query = originalQuery
  const deleted = await admin.from('apps').delete().eq('app_id', appId)
  assert.equal(deleted.error, null)
  for (const path of modulePaths) {
    try { unlinkSync(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
