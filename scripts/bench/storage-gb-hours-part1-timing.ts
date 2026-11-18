/**
 * Tinbase timing for 20261117152410 (data-only). Seeds ~1.3% of prod row counts,
 * applies part 1, extrapolates to prod-scale daily_storage_hourly / version_meta.
 */
import { Database, createPgliteEngine } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'

const BENCH_USER = '00000000-0000-4000-8000-000000000002'
const BENCH_ORG = '00000000-0000-4000-8000-000000000001'

const PROD = {
  daily_storage_hourly: 392_876,
  version_meta: 773_642,
} as const

const SCALE = 0.013
const SEED_DSH = Math.max(1, Math.round(PROD.daily_storage_hourly * SCALE))
const SEED_VM = Math.max(1, Math.round(PROD.version_meta * SCALE))

const database = await Database.create(await createPgliteEngine())
const project = await loadSupabaseProject(process.cwd())
const part1Migration = project.migrations.find((m) =>
  m.name.startsWith('20261117152410_storage_gb_hours_billing_data'),
)
if (!part1Migration)
  throw new Error('part1 migration 20261117152410 not found')

try {
  const prior = project.migrations.filter((m) => {
    const ts = Number(m.name.match(/^(\d+)/)?.[1] ?? 0)
    return ts > 0 && ts < 20261117152410
  })
  await database.runMigrations(prior)

  await database.query(`
    INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
    VALUES (
      '${BENCH_USER}'::uuid,
      'bench-storage-gb-hours@example.com',
      'not-a-real-hash',
      NOW(), NOW(), NOW(),
      '{}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING
  `)

  await database.query(`
    INSERT INTO public.users (id, email)
    VALUES ('${BENCH_USER}'::uuid, 'bench-storage-gb-hours@example.com')
    ON CONFLICT (id) DO NOTHING
  `)

  await database.query(`
    ALTER TABLE public.orgs DISABLE TRIGGER generate_org_user_stripe_info_on_org_create
  `)
  await database.query(`
    INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
    VALUES (
      '${BENCH_ORG}'::uuid,
      '${BENCH_USER}'::uuid,
      'Bench org',
      'bench-storage-gb-hours@example.com',
      NULL
    )
    ON CONFLICT (id) DO NOTHING
  `)
  await database.query(`
    ALTER TABLE public.orgs ENABLE TRIGGER generate_org_user_stripe_info_on_org_create
  `)

  // Bench only: prod has the FK until part 2 drops it; unlock inserts without provisioning apps.
  await database.query(`
    ALTER TABLE public.daily_storage_hourly
    DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey
  `)

  await database.query(`
    INSERT INTO public.daily_storage_hourly (app_id, owner_org, date, storage_byte_hours, updated_at)
    SELECT
      'com.bench.dsh.' || gs::text,
      '${BENCH_ORG}'::uuid,
      '2026-01-01'::date + (gs % 28),
      gs::double precision,
      now()
    FROM generate_series(1, ${SEED_DSH}) gs
    ON CONFLICT DO NOTHING
  `)

  await database.query(`
    INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
    SELECT
      '2026-01-01'::timestamp + (gs || ' seconds')::interval,
      'com.bench.vm.' || (gs % 5000)::text,
      gs::bigint,
      1024
    FROM generate_series(1, ${SEED_VM}) gs
    ON CONFLICT DO NOTHING
  `)

  const t0 = performance.now()
  await database.runMigrations([part1Migration])
  const seconds = (performance.now() - t0) / 1000
  const extrapolatedSeconds = seconds * (PROD.daily_storage_hourly / SEED_DSH)

  console.log(JSON.stringify({
    seed_daily_storage_hourly: SEED_DSH,
    seed_version_meta: SEED_VM,
    part1_seconds_tinbase: Number(seconds.toFixed(2)),
    extrapolated_part1_seconds_at_prod_dsh_rows: Number(extrapolatedSeconds.toFixed(0)),
    prod_row_estimates: PROD,
  }))
}
finally {
  await database.close()
}