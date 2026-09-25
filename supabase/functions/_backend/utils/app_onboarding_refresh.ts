import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { applyBuilderBuildOutcomeRepairs } from './builder_onboarding_checklist.ts'

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
  ios_build_succeeded: boolean | null
  ios_build_failed: boolean | null
  android_build_succeeded: boolean | null
  android_build_failed: boolean | null
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

    // Avoid reading large signal tables for messages already covered by a
    // later refresh. Recheck this after locking because another worker may win.
    const { rows: dueApps } = await tx.execute<{ app_id: string }>(sql`
      SELECT app_id FROM public.apps
      WHERE app_id = ANY(${sql.param(body.appIds)}::varchar[])
        AND COALESCE(onboarding->>'refreshed_at', '') < ${body.queuedAt}
      ORDER BY app_id
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
        br.first_build_at, br.first_success_at, br.last_build_at,
        br.ios_build_succeeded, br.ios_build_failed,
        br.android_build_succeeded, br.android_build_failed
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
          max(COALESCE(completed_at, created_at)) AS last_build_at,
          bool_or(platform = 'ios' AND status IN ('succeeded', 'released')) AS ios_build_succeeded,
          bool_or(platform = 'ios' AND status = 'failed') AS ios_build_failed,
          bool_or(platform = 'android' AND status IN ('succeeded', 'released')) AS android_build_succeeded,
          bool_or(platform = 'android' AND status = 'failed') AS android_build_failed
        FROM public.build_requests WHERE app_id = batch.app_id
      ) br ON true
      ORDER BY batch.app_id
    `)

    await tx.execute(sql`
      SELECT app_id FROM public.apps
      WHERE app_id = ANY(${sql.param(dueIds)}::varchar[])
      ORDER BY app_id FOR UPDATE
    `)
    const result = await tx.execute<{ app_id: string, onboarding: unknown }>(sql`
      WITH signals AS (
        SELECT * FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(signals)}::jsonb) AS s(
          app_id varchar, last_device_at timestamptz,
          has_app_store boolean, has_testflight boolean, has_play_unknown boolean,
          has_native boolean, has_install_source boolean,
          first_bundle_at timestamptz, last_bundle_at timestamptz,
          first_install_at timestamptz, last_install_at timestamptz,
          first_build_at timestamptz, first_success_at timestamptz, last_build_at timestamptz,
          ios_build_succeeded boolean, ios_build_failed boolean,
          android_build_succeeded boolean, android_build_failed boolean
        )
      )
      UPDATE public.apps a SET onboarding = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
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
        ), '{refreshed_at}',
        pg_catalog.to_jsonb(pg_catalog.to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        true
      )
      FROM signals s
      WHERE a.app_id = s.app_id
        AND COALESCE(a.onboarding->>'refreshed_at', '') < ${body.queuedAt}
      RETURNING a.app_id, a.onboarding
    `)

    const signalsByApp = new Map(signals.map(signal => [signal.app_id, signal]))
    const repairs = result.rows.flatMap((row) => {
      const signal = signalsByApp.get(row.app_id)
      if (!signal)
        return []
      const outcomes = (['ios', 'android'] as const).flatMap((platform) => {
        if (signal[`${platform}_build_succeeded`])
          return [{ platform, status: 'succeeded' }]
        return signal[`${platform}_build_failed`] ? [{ platform, status: 'failed' }] : []
      })
      const onboarding = applyBuilderBuildOutcomeRepairs(row.onboarding, outcomes)
      return onboarding ? [{ app_id: row.app_id, onboarding }] : []
    })
    if (repairs.length) {
      await tx.execute(sql`
        UPDATE public.apps AS app SET onboarding = repaired.onboarding, updated_at = now()
        FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(repairs)}::jsonb)
          AS repaired(app_id varchar, onboarding jsonb)
        WHERE app.app_id = repaired.app_id
      `)
    }
    return result.rowCount ?? 0
  })
}
