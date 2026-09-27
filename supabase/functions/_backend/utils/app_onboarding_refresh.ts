import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

export const ONBOARDING_APPS_PER_MESSAGE = 25
export const ONBOARDING_MESSAGES_PER_MINUTE = 4
export const onboardingRefreshBody = z.object({
  appIds: z.array(z.string().min(1)).min(1).max(ONBOARDING_APPS_PER_MESSAGE),
  queuedAt: z.iso.datetime(),
})

interface OnboardingSignals extends Record<string, unknown> {
  app_id: string
  last_device_at: Date | null
  has_app_store: boolean | null
  has_testflight: boolean | null
  has_play_unknown: boolean | null
  has_native: boolean | null
  has_install_source: boolean | null
  first_bundle_at: Date | null
  last_bundle_at: Date | null
  first_install_at: Date | null
  last_install_at: Date | null
  first_build_at: Date | null
  first_success_at: Date | null
  last_build_at: Date | null
}

export async function refreshAppOnboardingBatch(
  database: Pick<ReturnType<typeof getDrizzleClient>, 'transaction'>,
  body: z.infer<typeof onboardingRefreshBody>,
) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout', '35s', true),
      pg_catalog.set_config('lock_timeout', '5s', true),
      pg_catalog.set_config('TimeZone', 'UTC', true)
    `)

    // Messages queued before app_onboarding was deployed have no state row.
    // Seed one here so those batches remain processable after the migration.
    await tx.execute(sql`
      INSERT INTO public.app_onboarding (app_id)
      SELECT app_id FROM public.apps
      WHERE app_id = ANY(${sql.param(body.appIds)}::varchar[])
      ON CONFLICT (app_id) DO NOTHING
    `)

    // Avoid reading large signal tables for messages already covered by a
    // later refresh. Recheck this after locking because another worker may win.
    const { rows: dueApps } = await tx.execute<{ app_id: string }>(sql`
      SELECT state.app_id FROM public.app_onboarding state
      WHERE state.app_id = ANY(${sql.param(body.appIds)}::varchar[])
        AND (state.refreshed_at IS NULL OR state.refreshed_at < ${body.queuedAt}::timestamptz)
      ORDER BY state.app_id
    `)
    if (!dueApps.length)
      return 0

    const dueIds = dueApps.map(app => app.app_id)
    // Preserve the old cron's PostgreSQL evidence and date precision. Each
    // lateral aggregate starts from an indexed app_id and returns one row.
    const { rows: signals } = await tx.execute<OnboardingSignals>(sql`
      SELECT batch.app_id,
        d.last_device_at, d.has_app_store, d.has_testflight,
        d.has_play_unknown, d.has_native, d.has_install_source,
        v.first_bundle_at, v.last_bundle_at,
        dv.first_install_at, dv.last_install_at,
        br.first_build_at, br.first_success_at, br.last_build_at
      FROM pg_catalog.unnest(${sql.param(dueIds)}::varchar[]) AS batch(app_id)
      LEFT JOIN LATERAL (
        SELECT
          bool_or(install_source = 'app_store') AS has_app_store,
          bool_or(install_source = 'testflight') AS has_testflight,
          bool_or(install_source IN ('google_play', 'amazon_appstore', 'samsung_galaxy_store', 'huawei_appgallery')) AS has_play_unknown,
          bool_or(is_prod IS TRUE AND is_emulator IS NOT TRUE) AS has_native,
          bool_or(install_source IS NOT NULL) AS has_install_source,
          max(updated_at) AS last_device_at
        FROM public.devices
        WHERE app_id = batch.app_id
          AND (install_source IS NOT NULL OR (is_prod IS TRUE AND is_emulator IS NOT TRUE))
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT min(created_at) AS first_bundle_at, max(created_at) AS last_bundle_at
        FROM public.app_versions
        WHERE app_id = batch.app_id AND deleted IS NOT TRUE
          AND name IS DISTINCT FROM 'builtin' AND name IS DISTINCT FROM 'unknown'
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT min(date)::timestamptz AS first_install_at,
          max(date)::timestamptz AS last_install_at
        FROM public.daily_version
        WHERE app_id = batch.app_id AND COALESCE(install, 0) > 0
      ) dv ON true
      LEFT JOIN LATERAL (
        SELECT min(created_at) AS first_build_at,
          min(completed_at) FILTER (WHERE status IN ('succeeded', 'released')) AS first_success_at,
          max(COALESCE(completed_at, created_at)) AS last_build_at
        FROM public.build_requests WHERE app_id = batch.app_id
      ) br ON true
      ORDER BY batch.app_id
    `)

    await tx.execute(sql`
      SELECT app_id FROM public.apps
      WHERE app_id = ANY(${sql.param(dueIds)}::varchar[])
      ORDER BY app_id FOR UPDATE
    `)
    const result = await tx.execute(sql`
      WITH signals AS (
        SELECT * FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(signals)}::jsonb) AS s(
          app_id varchar, last_device_at timestamptz,
          has_app_store boolean, has_testflight boolean, has_play_unknown boolean,
          has_native boolean, has_install_source boolean,
          first_bundle_at timestamptz, last_bundle_at timestamptz,
          first_install_at timestamptz, last_install_at timestamptz,
          first_build_at timestamptz, first_success_at timestamptz, last_build_at timestamptz
        )
      ), updated AS (
        UPDATE public.apps a SET onboarding = pg_catalog.jsonb_set(
          a.onboarding, '{features}',
          COALESCE(a.onboarding->'features', '{}'::jsonb) || pg_catalog.jsonb_build_object(
            'cli_install', public.merge_app_onboarding_feature(
              a.onboarding->'features'->'cli_install', s.last_device_at,
              s.last_device_at, s.last_device_at, NULL),
            'ota', public.merge_app_onboarding_feature(
              a.onboarding->'features'->'ota', s.first_bundle_at, s.first_install_at,
              GREATEST(s.last_install_at, s.last_bundle_at),
              CASE
                WHEN s.has_app_store THEN 'store_live'
                WHEN s.has_testflight THEN 'testflight'
                WHEN s.has_play_unknown THEN 'play_unknown'
                WHEN s.has_native THEN 'native_unknown'
                WHEN s.has_install_source THEN 'local_only'
                ELSE 'no_device'
              END),
            'builder', public.merge_app_onboarding_feature(
              a.onboarding->'features'->'builder', s.first_build_at,
              s.first_success_at, s.last_build_at, NULL)
          ), true
        )
        FROM signals s
        JOIN public.app_onboarding state ON state.app_id = s.app_id
        WHERE a.app_id = s.app_id
          AND (state.refreshed_at IS NULL OR state.refreshed_at < ${body.queuedAt}::timestamptz)
        RETURNING a.app_id
      )
      INSERT INTO public.app_onboarding (app_id, refreshed_at)
      SELECT app_id, pg_catalog.now() FROM updated
      ON CONFLICT (app_id) DO UPDATE
      SET refreshed_at = EXCLUDED.refreshed_at
      RETURNING app_id
    `)
    return result.rowCount ?? 0
  })
}
