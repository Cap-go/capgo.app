import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import pg from 'pg'
import { USER_ID, USER_ID_2 } from '../../tests/test-utils.ts'

// Local seeded Supabase only. Copied tables retain the live indexes and read
// policies; public views let PostgREST exercise the same RLS and JSON response.
const connectionString = process.env.SUPABASE_DB_URL
assert(connectionString, 'Run through scripts/supabase-worktree.ts with-env')
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname), 'Local databases only')
const api = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY
assert(api && anonKey, 'Local API URL and anonymous key are required')
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname), 'Local APIs only')
const client = new pg.Client({ connectionString })
const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const schema = `bundle_list_bench_${suffix}`
const appId = `com.bench.bundle.list.${suffix}`
const deniedApp = `${appId}.denied`
const org = randomUUID()
const deniedOrg = randomUUID()
const key = randomUUID()
const views = Object.fromEntries(['before', 'after'].map(side => [side, `${schema}_${side}`]))
const migration = readFileSync(new URL('../../supabase/migrations/20261029025503_bundle_list_index.sql', import.meta.url), 'utf8')
const results = { rows: 300000, targetRows: 6000, errors: 0, work: { sqlPages: 0, httpPages: 0 }, runs: {}, plans: {}, http: {} }
const quote = pg.escapeLiteral
let keyId
const interruption = new AbortController()

/** Stop between SQL statements so signal cleanup never races an active query. */
async function query(...args) {
  interruption.signal.throwIfAborted()
  const result = await client.query(...args)
  interruption.signal.throwIfAborted()
  return result
}

/** Let the main flow unwind into its shared cleanup on a termination signal. */
function interrupt(signal) {
  if (interruption.signal.aborted) return
  process.exitCode = signal === 'SIGINT' ? 130 : 143
  interruption.abort(new Error(`Benchmark interrupted by ${signal}`))
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')

/** Remove this run's fixtures, rolling back failed setup before resetting role. */
async function cleanup() {
  try {
    await client.query('ROLLBACK')
    await client.query('RESET ROLE')
    for (const view of Object.values(views)) await client.query(`DROP VIEW IF EXISTS public.${view}`)
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    if (keyId) await client.query('DELETE FROM public.apikeys WHERE id=$1', [keyId])
    for (const app of [appId, deniedApp]) await client.query('SELECT public.reset_app_data($1)', [app])
    await client.query('DELETE FROM public.orgs WHERE id=ANY($1::uuid[])', [[org, deniedOrg]])
    await client.query("NOTIFY pgrst,'reload schema'")
  }
  finally {
    await client.end()
  }
}

/** Return the middle observation from the odd-sized timing samples. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
/** Retain raw timings alongside their median and range. */
function summary(values) {
  return { medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values), runsMs: values }
}
/** Apply the selected synthetic identity and its real database role. */
async function role(identity) {
  await query('RESET ROLE')
  await query("SELECT set_config('request.method', 'GET', false), set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)", [
    JSON.stringify(identity === 'user' ? { sub: USER_ID, role: 'authenticated', aal: 'aal2' } : {}),
    JSON.stringify(identity === 'key' ? { capgkey: key } : identity === 'invalid' ? { capgkey: 'invalid-bundle-list-benchmark' } : {}),
  ])
  await query(`SET ROLE ${identity === 'user' ? 'authenticated' : 'anon'}`)
}
/** Execute the same parameterized page on either benchmark table. */
function pageSql(side, deleted, offset = 0) {
  return `EXECUTE bundle_${side}(${quote(appId)}, 50, ${offset}, ${deleted})`
}
/** Compare numeric IDs consistently across JSON and SQL responses. */
function ids(rows) {
  return rows.map(row => Number(row.id))
}
/** Derive the expected descending page from the deterministic seed. */
function expectedIds(deleted, offset = 0) {
  return Array.from({ length: results.targetRows }, (_, i) => i + 1).reverse().filter(id => (id % 5 === 0) === deleted).slice(offset, offset + 50)
}
/** Fetch and validate a complete PostgREST page under the synthetic API key. */
async function httpPage(side, deleted = false, offset = 0) {
  const response = await fetch(`${api}/rest/v1/${views[side]}?select=*&app_id=eq.${appId}&deleted=eq.${deleted}&order=created_at.desc&limit=50&offset=${offset}`, {
    signal: interruption.signal,
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, capgkey: key },
  })
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.deepEqual(ids(body), expectedIds(deleted, offset))
  return body
}

await client.connect()
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
try {
  results.environment = { loadAverage: os.loadavg(), cpus: os.cpus().length }
  results.version = (await query('SHOW server_version')).rows[0].server_version
  // Match the production work_mem budget; both sides use identical settings.
  await query("SET work_mem = '16MB'; SET statement_timeout = '120s'")
  results.settings = (await query("SELECT name,setting,unit FROM pg_settings WHERE name IN ('jit','shared_buffers','work_mem','random_page_cost','effective_cache_size')")).rows
  await query('BEGIN')
  for (const [app, orgId, user] of [[appId, org, USER_ID], [deniedApp, deniedOrg, USER_ID_2]]) {
    await query('SELECT public.reset_and_seed_app_data($1,$2::uuid,$3::uuid,NULL,$4,NULL)', [app, orgId, user, `cus_bench_${randomUUID().replaceAll('-', '')}`])
  }
  const apiKey = (await query('INSERT INTO public.apikeys(user_id,key,name) VALUES ($1,$2,$3) RETURNING id,rbac_id', [USER_ID, key, `bundle-list-benchmark-${suffix}`])).rows[0]
  keyId = apiKey.id
  await query(`INSERT INTO public.role_bindings(principal_type,principal_id,role_id,scope_type,org_id,granted_by,reason,is_direct)
    SELECT 'apikey',$1::uuid,id,'org',$2::uuid,$3::uuid,'Synthetic bundle-list benchmark',true
    FROM public.roles WHERE name='org_admin' AND scope_type='org'`, [apiKey.rbac_id, org, USER_ID])
  await query(`CREATE SCHEMA ${schema}`)
  const indexes = (await query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='app_versions' AND indexname <> 'idx_app_versions_app_deleted_created_at' ORDER BY indexname")).rows
  const policies = (await query(`SELECT polpermissive,pg_get_expr(polqual,polrelid) AS expression,
      ARRAY(SELECT rolname::text FROM pg_roles WHERE oid=ANY(polroles)) AS roles
    FROM pg_policy WHERE polrelid='public.app_versions'::regclass AND polcmd IN ('r','*') ORDER BY polname`)).rows
  assert(policies.length >= 2, 'Expected both the read policy and MFA restriction')
  for (const side of ['before', 'after']) {
    await query(`CREATE TABLE ${schema}.${side} (LIKE public.app_versions INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
    for (const [i, { indexdef }] of indexes.entries())
      await query(indexdef.replace(/INDEX \S+ ON public\.app_versions/, `INDEX ${side}_i${i} ON ${schema}.${side}`))
    await query(`ALTER TABLE ${schema}.${side} ENABLE ROW LEVEL SECURITY`)
    for (const [i, policy] of policies.entries()) {
      const roles = policy.roles.length ? policy.roles.map(pg.escapeIdentifier).join(',') : 'PUBLIC'
      await query(`CREATE POLICY p${i} ON ${schema}.${side} AS ${policy.polpermissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR SELECT TO ${roles} USING (${policy.expression})`)
    }
    await query(`GRANT SELECT ON ${schema}.${side} TO anon,authenticated`)
  }
  console.error('Seeding 300,000 synthetic bundle rows per side...')
  await query(`INSERT INTO ${schema}.before(id,app_id,name,owner_org,user_id,created_at,updated_at,deleted,comment)
    SELECT g,CASE WHEN g<=6000 THEN $1 WHEN g<=12000 THEN $2 ELSE 'com.bench.bundle.noise.'||(g%3000) END,
      'bundle-'||g,CASE WHEN g<=6000 THEN $3::uuid ELSE $4::uuid END,$5::uuid,
      TIMESTAMPTZ '2024-01-01' + g * INTERVAL '1 minute',TIMESTAMPTZ '2024-01-01' + g * INTERVAL '1 minute',
      g%5=0,repeat(md5(g::text),16)
    FROM generate_series(1,300000) g`, [appId, deniedApp, org, deniedOrg, USER_ID])
  await query(`INSERT INTO ${schema}.after SELECT * FROM ${schema}.before`)
  const indexStarted = performance.now()
  await query(migration.replaceAll('public.idx_app_versions_app_deleted_created_at', `${schema}.idx_app_versions_app_deleted_created_at`).replaceAll('ON public.app_versions', `ON ${schema}.after`))
  results.indexBuildMs = performance.now() - indexStarted
  for (const side of ['before', 'after']) {
    await query(`ANALYZE ${schema}.${side}`)
    await query(`CREATE VIEW public.${views[side]} WITH (security_invoker=true) AS SELECT * FROM ${schema}.${side}`)
    await query(`GRANT SELECT ON public.${views[side]} TO anon,authenticated`)
  }
  await query(`GRANT USAGE ON SCHEMA ${schema} TO anon,authenticated`)
  results.indexBytes = Number((await query(`SELECT pg_relation_size('${schema}.idx_app_versions_app_deleted_created_at') AS bytes`)).rows[0].bytes)
  await query('COMMIT')
  await query("NOTIFY pgrst,'reload schema'")

  for (const mode of ['force_custom_plan', 'force_generic_plan']) {
    await query(`SET plan_cache_mode=${mode}`)
    for (const side of ['before', 'after'])
      await query(`PREPARE bundle_${side}(varchar,integer,integer,boolean) AS WITH q AS (
        SELECT * FROM ${schema}.${side} WHERE app_id=$1 AND deleted=$4 ORDER BY created_at DESC LIMIT $2 OFFSET $3
      ) SELECT pg_catalog.to_json(q.*) AS row FROM q`)
    await role('key')
    for (const [scenario, deleted, offset] of [['active', false, 0], ['deleted', true, 0], ['offset_1000', false, 1000]]) {
      const runs = { before: [], after: [] }
      let expected
      for (let round = -1; round < 9; round++) {
        for (const side of round % 2 ? ['after', 'before'] : ['before', 'after']) {
          const started = performance.now()
          const response = await query(pageSql(side, deleted, offset))
          const elapsed = performance.now() - started
          const rows = response.rows.map(row => row.row)
          assert.deepEqual(ids(rows), expectedIds(deleted, offset))
          expected ??= rows
          assert.deepEqual(rows, expected)
          results.work.sqlPages++
          if (round >= 0) runs[side].push(elapsed)
        }
      }
      const label = `${mode}:${scenario}`
      results.runs[label] = Object.fromEntries(Object.entries(runs).map(([side, values]) => [side, summary(values)]))
      results.plans[label] = {}
      for (const side of ['before', 'after'])
        results.plans[label][side] = (await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${pageSql(side, deleted, offset)}`)).rows[0]['QUERY PLAN'][0]
    }
    results.plans[`${mode}:access`] = {}
    for (const identity of ['anon', 'invalid', 'user']) {
      await role(identity)
      const plan = (await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${pageSql('after', false)}`)).rows[0]['QUERY PLAN'][0]
      const rows = (await query(pageSql('after', false))).rows.map(row => row.row)
      assert.deepEqual(ids(rows), identity === 'user' ? expectedIds(false) : [])
      results.plans[`${mode}:access`][identity] = plan
    }
    await query('RESET ROLE; DEALLOCATE ALL')
  }

  // Wait only for the local schema cache, outside all timed samples.
  let ready = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${api}/rest/v1/${views.after}?select=id&limit=0`, { signal: interruption.signal, headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } })
    if (response.ok) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert(ready, 'PostgREST did not load the benchmark views')
  for (const [scenario, deleted, offset] of [['active', false, 0], ['deleted', true, 0], ['offset_1000', false, 1000]]) {
    const runs = { before: [], after: [] }
    const requestsPerBatch = 10
    let expected
    for (let round = -1; round < 9; round++) {
      for (const side of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        const started = performance.now()
        for (let request = 0; request < requestsPerBatch; request++) {
          const body = await httpPage(side, deleted, offset)
          expected ??= body
          assert.deepEqual(body, expected)
          results.work.httpPages++
        }
        const elapsed = (performance.now() - started) / requestsPerBatch
        if (round >= 0) runs[side].push(elapsed)
      }
    }
    results.http[scenario] = { requestsPerBatch, ...Object.fromEntries(Object.entries(runs).map(([side, values]) => [side, summary(values)])) }
  }
  interruption.signal.throwIfAborted()
  console.log(JSON.stringify(results, null, 2))
}
catch (error) {
  results.errors++
  console.error(JSON.stringify({ errors: results.errors, work: results.work }))
  if (error !== interruption.signal.reason) throw error
  console.error(error.message)
}
finally {
  try {
    await cleanup()
  }
  catch (error) {
    // Preserve the benchmark failure when cleanup also fails.
    if (!results.errors) throw error
    console.error('Benchmark cleanup failed:', error)
  }
  finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
