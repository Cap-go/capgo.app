/**
 * PostgREST vs the Drizzle builder runner (utils/db.ts + utils/pg_query.ts),
 * same database, same requests, same sessions, same pool size.
 *
 * The operations are the busiest PostgREST routes in production (24h edge logs):
 * PATCH manifest, GET apps, GET app_versions, rpc/find_apikey_by_value, GET
 * channels, plus an API-key (anon + capgkey) and a JWT (authenticated) read.
 *
 * PostgREST is off in the project, so start a standalone one on the local stack:
 *   docker run -d --name capgo-bench-postgrest --network supabase_network_<project> -p 59990:3000 \
 *     -e PGRST_DB_URI=postgres://authenticator:postgres@supabase_db_<project>:5432/postgres \
 *     -e PGRST_DB_SCHEMAS=public -e PGRST_DB_EXTRA_SEARCH_PATH=public,extensions -e PGRST_DB_ANON_ROLE=anon \
 *     -e PGRST_JWT_SECRET=<local jwt secret> -e PGRST_DB_POOL=10 public.ecr.aws/supabase/postgrest:v14.14
 *   bun run supabase:with-env -- bun scripts/bench_db_runner.ts
 *
 * Env: POSTGREST_URL (default http://127.0.0.1:59990), BENCH_REQUESTS (400), BENCH_CONCURRENCY (20).
 */
import type { ConsoleQueryRequest } from '../supabase/functions/_backend/private/console_query_sql.ts'
import type { PgQuerySession } from '../supabase/functions/_backend/utils/pg_query.ts'
import { env } from 'node:process'
import { PostgrestClient } from '@supabase/postgrest-js'
import { createClient as createSdkClient } from '@supabase/supabase-js'
import { Pool } from 'pg'
import { createDbClient } from '../supabase/functions/_backend/utils/db.ts'
import { runPgQuery } from '../supabase/functions/_backend/utils/pg_query.ts'

const POSTGREST_URL = env.POSTGREST_URL ?? 'http://127.0.0.1:59990'
const REQUESTS = Number(env.BENCH_REQUESTS ?? 400)
const CONCURRENCY = Number(env.BENCH_CONCURRENCY ?? 20)
const APIKEY = 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'
// Seeded by supabase/seed.sql (owner: test@capgo.app).
const APP_ID = 'com.demo.app'
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ANON_KEY = env.SUPABASE_ANON_KEY ?? ''

const pool = new Pool({ connectionString: env.SUPABASE_DB_URL, max: 10 })

function runner(session: PgQuerySession) {
  return createDbClient(async (request: ConsoleQueryRequest) => {
    const client = await pool.connect()
    try {
      return await runPgQuery(client, request, session)
    }
    finally {
      client.release()
    }
  })
}

function postgrest(bearer: string, headers: Record<string, string> = {}) {
  return new PostgrestClient(POSTGREST_URL, { headers: { Authorization: `Bearer ${bearer}`, ...headers } })
}

type Builder = Pick<ReturnType<typeof runner>, 'from' | 'rpc'>
type Result = { data: unknown, error: unknown }
type Operation = (db: Builder) => PromiseLike<Result>

function serviceOperations(manifestId: number): Record<string, Operation> {
  return {
    'rpc find_apikey_by_value': db => db.rpc('find_apikey_by_value', { key_value: APIKEY }).single(),
    'GET apps (one row)': db => db.from('apps').select('app_id, owner_org, name').eq('app_id', APP_ID).single(),
    'GET app_versions (one row)': db => db.from('app_versions').select('id, name').eq('app_id', APP_ID).eq('name', '1.0.0').single(),
    'GET channels + embeds': db => db.from('channels').select('id, name, version:app_versions!channels_version_fkey(id, name)').eq('app_id', APP_ID),
    // Like the hot route: an indexed update of one existing row, no representation.
    'PATCH manifest (one row)': db => db.from('manifest').update({ file_size: 1 }).eq('id', manifestId),
  }
}

// Every timed operation must touch real rows on both paths, or the numbers
// measure empty results. Writes are checked with a returning variant.
async function assertReturnsRows(name: string, side: string, result: Result) {
  const empty = result.data == null || (Array.isArray(result.data) && result.data.length === 0)
  if (result.error || empty)
    throw new Error(`${name} (${side}) returned no rows: ${JSON.stringify(result.error ?? result.data)}`)
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function measure(label: string, run: () => PromiseLike<Result>) {
  for (let index = 0; index < 20; index++)
    await run()
  const latencies: number[] = []
  let failures = 0
  let next = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < REQUESTS) {
      next++
      const begin = performance.now()
      const { error } = await run()
      latencies.push(performance.now() - begin)
      if (error)
        failures++
    }
  }))
  const seconds = (performance.now() - started) / 1000
  latencies.sort((left, right) => left - right)
  return { label, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), rps: REQUESTS / seconds, failures }
}

async function main() {
  const auth = createSdkClient(env.SUPABASE_URL!, ANON_KEY, { auth: { persistSession: false } })
  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({ email: 'test@capgo.app', password: 'testtest' })
  if (signInError || !signIn.session)
    throw signInError ?? new Error('sign-in failed')
  const jwt = signIn.session.access_token
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as { sub: string, email?: string, aal?: string }

  const sides = {
    service: { postgrest: postgrest(SERVICE_KEY), runner: runner({ role: 'service' }) },
    apikey: { postgrest: postgrest(ANON_KEY, { capgkey: APIKEY }), runner: runner({ role: 'anon', headers: { capgkey: APIKEY } }) },
    jwt: { postgrest: postgrest(jwt), runner: runner({ role: 'authenticated', claims: { ...claims, role: 'authenticated' } }) },
  }
  // A real manifest row for the update to hit (the local seed has none).
  const version = await pool.query<{ id: number }>('SELECT id FROM public.app_versions WHERE app_id = $1 ORDER BY id LIMIT 1', [APP_ID])
  const manifest = await pool.query<{ id: number }>(
    'INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size) VALUES ($1, $2, $3, $4, 0) RETURNING id',
    [version.rows[0].id, 'bench.js', 'bench/bench.js', 'bench-hash'],
  )
  const manifestId = manifest.rows[0].id

  const plan: Array<[string, keyof typeof sides, Operation]> = [
    ...Object.entries(serviceOperations(manifestId)).map(([name, op]) => [name, 'service', op] as [string, keyof typeof sides, Operation]),
    ['API key: GET apps (RLS)', 'apikey', db => db.from('apps').select('app_id, name').eq('app_id', APP_ID)],
    ['JWT: GET orgs (RLS)', 'jwt', db => db.from('orgs').select('id, name')],
  ]

  for (const [name, side, op] of plan) {
    for (const [label, db] of [['PostgREST', sides[side].postgrest as unknown as Builder], ['Drizzle runner', sides[side].runner]] as const) {
      const check = name.startsWith('PATCH')
        ? await db.from('manifest').update({ file_size: 2 }).eq('id', manifestId).select('id')
        : await op(db)
      await assertReturnsRows(name, label, check)
    }
  }

  const rows: string[] = []
  for (const [name, side, op] of plan) {
    const before = await measure('PostgREST', () => op(sides[side].postgrest as unknown as Builder))
    const after = await measure('Drizzle runner', () => op(sides[side].runner))
    for (const result of [before, after])
      rows.push(`| ${name} | ${result.label} | ${result.p50.toFixed(2)} | ${result.p95.toFixed(2)} | ${result.p99.toFixed(2)} | ${result.rps.toFixed(0)} | ${result.failures} |`)
  }
  console.log(`requests=${REQUESTS} concurrency=${CONCURRENCY} pool=10 (both sides)\n`)
  console.log('| Operation | Path | p50 ms | p95 ms | p99 ms | req/s | errors |')
  console.log('|---|---|---|---|---|---|---|')
  console.log(rows.join('\n'))
  await pool.query('DELETE FROM public.manifest WHERE id = $1', [manifestId])
  await pool.end()
}

await main()
