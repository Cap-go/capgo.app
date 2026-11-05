import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { compileConsoleQuery } from '../../supabase/functions/_backend/private/console_query_sql.ts'

// Run with Bun against a seeded local database. Only isolated schema copies
// are committed for concurrent readers, then dropped. Public fixtures roll back.
const connectionString = process.env.AUDIT_BENCH_DATABASE_URL
assert(connectionString, 'Set AUDIT_BENCH_DATABASE_URL to a seeded local database')
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname), 'Local databases only')
const client = new pg.Client({ connectionString })
const schema = `audit_bundle_history_bench_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const owner = 'c591b04e-cf29-4945-b9a0-776d0672061a'
const org = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const otherOrg = '34a8c55d-2d0f-4652-a43f-684c7a9403ac'
const migration = readFileSync(new URL('../../supabase/migrations/20261029003622_audit_bundle_history_index.sql', import.meta.url), 'utf8')
const results = { rows: 360000, runs: {}, plans: {}, errors: 0 }

await client.connect()
try {
  await client.query('BEGIN')
  await client.query("SET LOCAL statement_timeout = '120s'")
  results.version = (await client.query('SHOW server_version')).rows[0].server_version
  results.settings = (await client.query("SELECT name, setting FROM pg_settings WHERE name IN ('jit', 'shared_buffers', 'work_mem', 'random_page_cost')")).rows
  await client.query(`CREATE SCHEMA ${schema}`)
  const indexes = (await client.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_logs' AND indexname <> 'idx_audit_logs_channel_old_bundle'")).rows
  for (const side of ['before', 'after']) {
    await client.query(`CREATE TABLE ${schema}.${side} (LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
    for (const { indexname, indexdef } of indexes) {
      await client.query(indexdef.replace(`"${indexname}"`, `${side}_${indexname}`).replace(`INDEX ${indexname}`, `INDEX ${side}_${indexname}`).replace('ON public.audit_logs', `ON ${schema}.${side}`))
    }
    await client.query(`ALTER TABLE ${schema}.${side} ENABLE ROW LEVEL SECURITY`)
    await client.query(`CREATE POLICY audit_read ON ${schema}.${side} FOR SELECT TO anon, authenticated USING (org_id = ANY(COALESCE((SELECT public.audit_logs_allowed_orgs()), '{}'::uuid[])))`)
    await client.query(`GRANT SELECT ON ${schema}.${side} TO anon, authenticated`)
  }
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated`)
  console.error('Seeding 360,000 synthetic audit rows per side...')
  await client.query(`
    INSERT INTO ${schema}.before (id, created_at, table_name, record_id, operation, org_id, old_record, changed_fields)
    SELECT g, TIMESTAMPTZ '2026-01-01' + g * interval '1 second',
      CASE WHEN g <= 11000 OR g % 4 = 0 OR g = 22001 THEN 'channels' ELSE 'apps' END,
      'channel-' || g, 'UPDATE', CASE WHEN g <= 22000 THEN $1::uuid ELSE $2::uuid END,
      jsonb_build_object(
        'app_id', CASE WHEN g IN (1, 2, 22001) THEN 'com.bench.audit.target' ELSE 'com.bench.audit.noise.' || (g % 500) END,
        'version', CASE WHEN g IN (1, 2, 22001) THEN 97001 ELSE 100000 + g % 1000 END,
        'payload', (SELECT string_agg(md5(g::text || ':' || n), '') FROM generate_series(1, 24) n)
      ),
      CASE WHEN g <= 11000 OR g % 4 = 0 OR g = 22001 THEN ARRAY['version'] ELSE ARRAY['name'] END
    FROM generate_series(1, 360000) g
  `, [org, otherOrg])
  await client.query(`INSERT INTO ${schema}.after SELECT * FROM ${schema}.before`)
  await client.query(migration.replace('ON public.audit_logs', `ON ${schema}.after`).replaceAll('public.get_bundle_channel_removals', `${schema}.get_bundle_channel_removals`).replace('FROM public.audit_logs', `FROM ${schema}.after`))
  for (const side of ['before', 'after'])
    await client.query(`ANALYZE ${schema}.${side}`)
  results.indexBytes = Number((await client.query(`SELECT pg_relation_size('${schema}.idx_audit_logs_channel_old_bundle') AS bytes`)).rows[0].bytes)
  results.indexedRows = Number((await client.query(`SELECT count(*) FROM ${schema}.after WHERE table_name = 'channels' AND operation = 'UPDATE' AND changed_fields @> ARRAY['version']`)).rows[0].count)

  const columns = (await client.query("SELECT a.attname AS name, t.typname AS udt FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = 'public.audit_logs'::regclass AND a.attnum > 0 AND NOT a.attisdropped")).rows
  const compiled = compileConsoleQuery({ columns: new Map([['audit_logs', columns]]), foreignKeys: [], functions: [] }, {
    kind: 'table', name: 'audit_logs', args: [], operations: [
      { method: 'select', args: ['id, record_id, user_id, created_at', { count: 'estimated' }] },
      { method: 'eq', args: ['table_name', 'channels'] },
      { method: 'eq', args: ['operation', 'UPDATE'] },
      { method: 'contains', args: ['changed_fields', ['version']] },
      { method: 'eq', args: ['old_record->>app_id', 'com.bench.audit.target'] },
      { method: 'eq', args: ['old_record->>version', '97001'] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'limit', args: [20] },
    ],
  })
  const queryFor = side => side === 'before'
    ? compiled.text.replaceAll('"public"."audit_logs"', `${schema}.before`)
    : `SELECT ${schema}.get_bundle_channel_removals($1, $2) AS result`
  const paramsFor = side => side === 'before' ? compiled.values : ['com.bench.audit.target', 97001]
  results.query = { before: compiled, after: { text: queryFor('after'), values: paramsFor('after') } }
  await client.query('SET LOCAL ROLE authenticated')
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated', aal: 'aal2' })])
  let expected
  // One warmup, then 7 samples. Reverse side order on alternate rounds.
  for (let round = -1; round < 7; round++) {
    for (const side of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      const started = performance.now()
      const response = await client.query(queryFor(side), paramsFor(side))
      const elapsed = performance.now() - started
      const result = side === 'before'
        ? { data: response.rows.map(row => row.row), count: Number(response.rows[0]?.total_count) }
        : response.rows[0].result
      assert.equal(result.count, 2)
      assert.deepEqual(result.data.map(row => row.id), [2, 1])
      expected ??= result
      assert.deepEqual(result, expected)
      if (round >= 0)
        (results.runs[side] ??= []).push(elapsed)
    }
  }
  // Profile separately so EXPLAIN instrumentation is outside the timed samples.
  results.plans.before = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queryFor('before')}`, paramsFor('before'))).rows[0]['QUERY PLAN'][0]
  await client.query('RESET ROLE')
  // Profile the function's SQL as its table-owning definer, with a generic plan
  // too. Supabase's local postgres role cannot LOAD auto_explain.
  const allowedOrgs = (await client.query('SELECT public.audit_logs_allowed_orgs() AS orgs')).rows[0].orgs
  let body = migration.slice(migration.indexOf('WITH removals AS NOT MATERIALIZED'), migration.indexOf(' INTO result;'))
  body = body.replace('FROM public.audit_logs', `FROM ${schema}.after`)
  const bindings = { allowed_orgs: '$1::uuid[]', p_app_id: '$2::text', p_version_id: '$3::bigint', p_channel_ids: '$4::text[]', p_ascending: '$5::boolean', p_limit: '$6::integer' }
  for (const [name, placeholder] of Object.entries(bindings))
    body = body.replaceAll(new RegExp(`\\b${name}\\b`, 'g'), placeholder)
  const values = [allowedOrgs, 'com.bench.audit.target', 97001, null, false, 20]
  results.plans.after = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${body}`, values)).rows[0]['QUERY PLAN'][0]
  await client.query('SET LOCAL plan_cache_mode = force_generic_plan')
  await client.query(`PREPARE audit_history_generic (uuid[], text, bigint, text[], boolean, integer) AS ${body}`)
  results.plans.afterGeneric = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE audit_history_generic(ARRAY['${org}'::uuid], 'com.bench.audit.target', 97001, NULL, false, 20)`)).rows[0]['QUERY PLAN'][0]
  assert(JSON.stringify(results.plans.afterGeneric).includes('idx_audit_logs_channel_old_bundle'), 'Even the generic function plan must use the new index')
  for (const side of ['before', 'after']) {
    const sorted = results.runs[side].toSorted((a, b) => a - b)
    results[side] = { medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6] }
  }
  // Exercise the existing permission helper with many caller-scoped bindings.
  // These public child fixtures never commit or alter the seeded parent user.
  await client.query('SAVEPOINT many_orgs')
  const orgIds = Array.from({ length: 32 }, () => randomUUID())
  await client.query(`INSERT INTO public.orgs (id, created_by, name, management_email)
    SELECT id, $2::uuid, 'Audit benchmark ' || id, 'audit-benchmark@example.com' FROM unnest($1::uuid[]) AS id`, [orgIds, owner])
  await client.query(`INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
    SELECT 'user', $2::uuid, (SELECT id FROM public.roles WHERE name = 'org_super_admin'), 'org', candidate.org_id, $2::uuid
    FROM unnest($1::uuid[]) AS candidate(org_id) WHERE NOT EXISTS (
      SELECT 1 FROM public.role_bindings r WHERE r.org_id = candidate.org_id AND r.principal_id = $2::uuid AND r.scope_type = 'org'
    )`, [orgIds, owner])
  await client.query('SET LOCAL ROLE authenticated')
  results.manyOrgs = { allowedOrgs: (await client.query('SELECT cardinality(public.audit_logs_allowed_orgs()) AS count')).rows[0].count }
  assert(results.manyOrgs.allowedOrgs >= 34)
  const manyStarted = performance.now()
  const manyResult = (await client.query(queryFor('after'), paramsFor('after'))).rows[0].result
  results.manyOrgs.elapsedMs = performance.now() - manyStarted
  assert.deepEqual(manyResult, expected)
  await client.query('ROLLBACK TO SAVEPOINT many_orgs')

  // Calls without the required indexed app/bundle arguments cannot run.
  await client.query('SAVEPOINT missing_arguments')
  await assert.rejects(client.query(`SELECT ${schema}.get_bundle_channel_removals()`), { code: '42883' })
  await client.query('ROLLBACK TO SAVEPOINT missing_arguments')

  // Publish only the isolated copied tables so separate connections can read.
  await client.query('COMMIT')
  results.concurrent = {}
  for (const side of ['before', 'after']) {
    const readers = Array.from({ length: 8 }, () => new pg.Client({ connectionString }))
    try {
      await Promise.all(readers.map(async reader => {
        await reader.connect()
        await reader.query('BEGIN')
        await reader.query('SET LOCAL ROLE authenticated')
        await reader.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated', aal: 'aal2' })])
      }))
      const requests = readers.map(async reader => {
        const started = performance.now()
        const response = await reader.query(queryFor(side), paramsFor(side))
        const elapsedMs = performance.now() - started
        const result = side === 'before'
          ? { data: response.rows.map(row => row.row), count: Number(response.rows[0]?.total_count) }
          : response.rows[0].result
        assert.deepEqual(result, expected)
        return elapsedMs
      })
      const lightStarted = performance.now()
      const light = client.query('SELECT id FROM public.orgs LIMIT 1').then(response => {
        assert.equal(response.rows.length, 1)
        return performance.now() - lightStarted
      })
      const [requestMs, lightQueryMs] = await Promise.all([Promise.all(requests), light])
      results.concurrent[side] = { requestMs, lightQueryMs }
    }
    finally {
      await Promise.all(readers.map(async reader => {
        try { await reader.query('ROLLBACK') }
        finally { await reader.end() }
      }))
    }
  }
  console.log(JSON.stringify(results, null, 2))
}
finally {
  await client.query('ROLLBACK')
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await client.end()
}
