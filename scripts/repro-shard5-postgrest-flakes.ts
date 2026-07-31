/**
 * Reproduce backend shard 5/6 PostgREST/Kong upstream flakes without Vitest retries.
 *
 * CI evidence:
 * - stats createAppVersions via PostgREST → "An invalid response was received from the upstream server"
 * - organization-api capgkey auth via PostgREST → intermittent 401 invalid_apikey
 *
 * This script forces the upstream failure mode by pausing the local PostgREST
 * container during the old-path hammer, then proves direct SQL still succeeds.
 *
 * Usage (Supabase must be running):
 *   bun run supabase:with-env -- bun scripts/repro-shard5-postgrest-flakes.ts
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SERVICE_ROLE_KEY
const DB_URL = process.env.SUPABASE_DB_URL ?? process.env.DB_URL

if (!SUPABASE_URL || !SERVICE_KEY || !DB_URL) {
  console.error('Missing SUPABASE_URL / service key / DB URL. Use: bun run supabase:with-env -- bun scripts/repro-shard5-postgrest-flakes.ts')
  process.exit(2)
}

const ORG_ID = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
const USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'
const PARALLEL = Number(process.env.REPRO_PARALLEL ?? 20)
const REQUEST_TIMEOUT_MS = Number(process.env.REPRO_TIMEOUT_MS ?? 2000)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: {
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  },
})
const pool = new pg.Pool({ connectionString: DB_URL, max: 10 })

function findPostgrestContainer(): string | null {
  const listed = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
  if (listed.status !== 0)
    return null
  const names = listed.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  return names.find(name => name.includes('rest') && name.includes('capgo'))
    ?? names.find(name => name.includes('rest'))
    ?? null
}

function dockerAction(action: 'pause' | 'unpause', container: string) {
  const result = spawnSync('docker', [action, container], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`docker ${action} ${container} failed: ${result.stderr || result.stdout}`)
  }
}

async function ensureApp(appId: string) {
  await pool.query(
    `INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id)
     VALUES ($1, '', $1, $2::uuid, $3::uuid)
     ON CONFLICT (app_id) DO NOTHING`,
    [appId, ORG_ID, USER_ID],
  )
}

async function cleanupApp(appId: string) {
  await pool.query('DELETE FROM public.app_versions WHERE app_id = $1', [appId])
  await pool.query('DELETE FROM public.apps WHERE app_id = $1', [appId])
}

async function postgrestCreateVersion(appId: string, version: string) {
  try {
    const { data, error } = await supabase.from('app_versions').upsert({
      app_id: appId,
      name: version,
      owner_org: ORG_ID,
    }, {
      onConflict: 'app_id,name',
    }).select('id,name').single()
    if (error || !data)
      return { ok: false as const, error: error?.message ?? 'no data' }
    return { ok: true as const }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false as const, error: message }
  }
}

async function sqlCreateVersion(appId: string, version: string) {
  const result = await pool.query(
    `INSERT INTO public.app_versions (app_id, name, owner_org)
     VALUES ($1, $2, $3::uuid)
     ON CONFLICT (name, app_id) DO UPDATE SET updated_at = now()
     RETURNING id, name`,
    [appId, version, ORG_ID],
  )
  if (!result.rows[0])
    return { ok: false as const, error: 'no data' }
  return { ok: true as const }
}

async function runBatch(
  label: string,
  fn: (appId: string, version: string) => Promise<{ ok: boolean, error?: string }>,
) {
  const appId = `com.repro.shard5.${randomUUID().slice(0, 8)}`
  await ensureApp(appId)
  const results = await Promise.all(
    Array.from({ length: PARALLEL }, (_, i) => {
      const version = `1.0.0-repro-${i}-${randomUUID().slice(0, 8)}`
      return fn(appId, version)
    }),
  )
  const failures = results.filter(r => !r.ok)
  const errors = new Map<string, number>()
  for (const failure of failures) {
    const key = failure.error ?? 'unknown'
    errors.set(key, (errors.get(key) ?? 0) + 1)
  }
  console.log(`\n[${label}] failures=${failures.length}/${PARALLEL} (${((failures.length / PARALLEL) * 100).toFixed(1)}%)`)
  for (const [message, count] of [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5))
    console.log(`  - ${count}x ${message}`)
  await cleanupApp(appId)
  return failures.length
}

const container = findPostgrestContainer()
if (!container) {
  console.error('Could not find local Postgrest docker container')
  process.exit(2)
}
console.log(`Using PostgREST container: ${container}`)

let postgrestFailures = 0
try {
  dockerAction('pause', container)
  await Bun.sleep(300)
  postgrestFailures = await runBatch('PostgREST upsert while upstream paused (old path)', postgrestCreateVersion)
}
finally {
  try {
    dockerAction('unpause', container)
  }
  catch {
    // already running
  }
  await Bun.sleep(300)
}

const sqlFailures = await runBatch('Direct SQL upsert (fixed path)', sqlCreateVersion)

await pool.end()

if (postgrestFailures < PARALLEL) {
  console.error('\nExpected PostgREST path to fail 100% while upstream is paused.')
  process.exit(1)
}

if (sqlFailures > 0) {
  console.error('\nSQL path failed — fix is incomplete.')
  process.exit(1)
}

console.log('\nRepro locked: PostgREST path fails 100% on upstream outage; direct SQL stays green.')
process.exit(0)
