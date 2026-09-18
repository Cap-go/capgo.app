import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { getEnv } from './utils.ts'

export const ONBOARDING_APPS_PER_MESSAGE = 20
export const ONBOARDING_MESSAGES_PER_MINUTE = 15
export const onboardingRefreshBody = z.object({
  appIds: z.array(z.string().min(1).max(255)).min(1).max(ONBOARDING_APPS_PER_MESSAGE),
  batchToken: z.uuid(),
})

interface AppWindow extends Record<string, unknown> {
  app_id: string
  created_at: Date | string
}
const stages = ['no_device', 'local_only', 'native_unknown', 'play_unknown', 'testflight', 'store_live'] as const
const telemetryRow = z.object({
  app_id: z.string(),
  first_at: z.coerce.date(),
  last_at: z.coerce.date(),
})
const deviceRow = telemetryRow.extend({ stage: z.enum(stages) })

function windowFilter(apps: AppWindow[], now: Date) {
  if (!apps.length || apps.length > ONBOARDING_APPS_PER_MESSAGE)
    throw new Error('Invalid onboarding telemetry batch size')
  const cutoff = new Date(now)
  const day = cutoff.getUTCDate()
  cutoff.setUTCDate(1)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3)
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()
  cutoff.setUTCDate(Math.min(day, lastDay))
  return apps.map((app) => {
    const created = new Date(app.created_at)
    if (!app.app_id || app.app_id.length > 255 || !Number.isFinite(created.getTime()))
      throw new Error('Invalid onboarding telemetry window')
    const start = created > cutoff ? created : cutoff
    return `(index1 = '${escapeSqlString(app.app_id)}' AND timestamp >= toDateTime('${formatDateCF(start)}') AND timestamp < toDateTime('${formatDateCF(now)}'))`
  }).join(' OR ')
}

export function buildOnboardingTelemetryQueries(apps: AppWindow[], now: Date) {
  const where = windowFilter(apps, now)
  // version_usage.install is emitted only by production, non-emulator `set`.
  // Read the original Cloudflare timestamps, without the daily_version rollup.
  const installs = `SELECT index1 AS app_id, min(timestamp) AS first_at, max(timestamp) AS last_at
FROM version_usage WHERE (${where}) AND blob3 = 'install' AND blob2 NOT IN ('', 'builtin', 'unknown')
GROUP BY index1 LIMIT ${ONBOARDING_APPS_PER_MESSAGE}`
  const devices = `SELECT index1 AS app_id,
if(blob9 = 'app_store', 'store_live', if(blob9 = 'testflight', 'testflight', if(blob9 IN ('google_play', 'amazon_appstore', 'samsung_galaxy_store', 'huawei_appgallery'), 'play_unknown', if(double2 = 1 AND double3 = 0, 'native_unknown', 'local_only')))) AS stage,
min(timestamp) AS first_at, max(timestamp) AS last_at
FROM device_info WHERE (${where}) AND (blob9 != '' OR (double2 = 1 AND double3 = 0))
GROUP BY index1, stage LIMIT ${ONBOARDING_APPS_PER_MESSAGE * stages.length}`
  if (Math.max(installs.length, devices.length) > 9000)
    throw new Error('Onboarding telemetry query exceeds its size budget')
  return { installs, devices }
}

export async function readOnboardingTelemetry(c: Context, apps: AppWindow[], now: Date) {
  if (!c.env.VERSION_USAGE || !c.env.DEVICE_INFO || !getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    throw new Error('Cloudflare onboarding telemetry is not configured')
  const queries = buildOnboardingTelemetryQueries(apps, now)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const [installResults, deviceResults] = await Promise.all([
      runQueryToCFA<unknown>(c, queries.installs, { signal: controller.signal }),
      runQueryToCFA<unknown>(c, queries.devices, { signal: controller.signal }),
    ])
    const installs = z.array(telemetryRow).parse(installResults)
    const devices = z.array(deviceRow).parse(deviceResults)
    const appIds = new Set(apps.map(app => app.app_id))
    for (const row of [...installs, ...devices]) {
      const app = apps.find(app => app.app_id === row.app_id)
      if (!appIds.has(row.app_id) || !app || row.first_at > row.last_at || row.last_at > now || row.first_at.getTime() < Math.floor(new Date(app.created_at).getTime() / 1000) * 1000)
        throw new Error('Cloudflare returned invalid onboarding telemetry')
    }
    if (installs.length > apps.length || devices.length > apps.length * stages.length)
      throw new Error('Cloudflare returned an oversized onboarding telemetry batch')
    if (new Set(installs.map(row => row.app_id)).size !== installs.length || new Set(devices.map(row => `${row.app_id}:${row.stage}`)).size !== devices.length)
      throw new Error('Cloudflare returned duplicate onboarding telemetry')
    return apps.map(app => ({
      app_id: app.app_id,
      first_install_at: installs.find(row => row.app_id === app.app_id)?.first_at.toISOString() ?? null,
      last_install_at: installs.find(row => row.app_id === app.app_id)?.last_at.toISOString() ?? null,
      first_device_at: devices.filter(row => row.app_id === app.app_id).reduce<string | null>((at, row) => !at || row.first_at.toISOString() < at ? row.first_at.toISOString() : at, null),
      last_device_at: devices.filter(row => row.app_id === app.app_id).reduce<string | null>((at, row) => !at || row.last_at.toISOString() > at ? row.last_at.toISOString() : at, null),
      stage: devices.filter(row => row.app_id === app.app_id).reduce<string>((stage, row) => stages.indexOf(row.stage) > stages.indexOf(stage as typeof stages[number]) ? row.stage : stage, 'no_device'),
    }))
  }
  finally {
    controller.abort()
    clearTimeout(timer)
  }
}

export async function refreshAppOnboardingBatch(c: Context, database: Pick<ReturnType<typeof getDrizzleClient>, 'execute' | 'transaction'>, body: z.infer<typeof onboardingRefreshBody>, now = new Date()) {
  // A replaced lease makes old queue messages harmless. Deleted apps disappear
  // through the FK. No transaction/row lock is held during Cloudflare reads.
  const { rows: apps } = await database.execute<AppWindow>(sql`
    SELECT a.app_id, a.created_at FROM public.apps a
    JOIN public.app_onboarding_refresh_jobs j ON j.app_id = a.app_id
    WHERE a.app_id = ANY(${sql.param(body.appIds)}::varchar[]) AND j.batch_token = ${body.batchToken}::uuid
    ORDER BY a.app_id`)
  if (!apps.length)
    return 0
  const telemetry = await readOnboardingTelemetry(c, apps, now)
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout', '10s', true),
      pg_catalog.set_config('lock_timeout', '2s', true)
    `)
    // Match deterministic app lock order. The UPDATE below merges into the live
    // row, preserving concurrent CLI setup reports and unrelated feature keys.
    await tx.execute(sql`SELECT app_id FROM public.apps WHERE app_id = ANY(${sql.param(apps.map(app => app.app_id))}::varchar[]) ORDER BY app_id FOR UPDATE`)
    const result = await tx.execute(sql`
WITH signals AS (
  SELECT s.* FROM jsonb_to_recordset(${JSON.stringify(telemetry)}::jsonb) AS s(app_id varchar, first_install_at timestamptz, last_install_at timestamptz, first_device_at timestamptz, last_device_at timestamptz, stage text)
  JOIN public.app_onboarding_refresh_jobs j ON j.app_id = s.app_id AND j.batch_token = ${body.batchToken}::uuid
), refreshed AS (
  UPDATE public.apps a SET onboarding = jsonb_strip_nulls(
    COALESCE(a.onboarding, '{}'::jsonb) || jsonb_build_object(
      'refreshed_at', ${now.toISOString()}::text,
      'features', COALESCE(a.onboarding->'features', '{}'::jsonb) || jsonb_build_object(
        'cli_install', public.merge_app_onboarding_feature(a.onboarding->'features'->'cli_install', s.first_device_at, s.first_device_at, s.last_device_at, NULL),
        'ota', public.merge_app_onboarding_feature(a.onboarding->'features'->'ota',
          (SELECT v.created_at FROM public.app_versions v WHERE v.app_id = a.app_id AND v.deleted IS NOT TRUE AND v.name IS DISTINCT FROM 'builtin' AND v.name IS DISTINCT FROM 'unknown' ORDER BY v.created_at LIMIT 1),
          s.first_install_at,
          GREATEST(s.last_install_at, (SELECT v.created_at FROM public.app_versions v WHERE v.app_id = a.app_id AND v.deleted IS NOT TRUE AND v.name IS DISTINCT FROM 'builtin' AND v.name IS DISTINCT FROM 'unknown' AND v.created_at IS NOT NULL ORDER BY v.created_at DESC LIMIT 1)), s.stage),
        'builder', public.merge_app_onboarding_feature(a.onboarding->'features'->'builder',
          (SELECT b.created_at FROM public.build_requests b WHERE b.app_id = a.app_id ORDER BY b.created_at LIMIT 1),
          (SELECT b.completed_at FROM public.build_requests b WHERE b.app_id = a.app_id AND b.status IN ('succeeded', 'released') AND b.completed_at IS NOT NULL ORDER BY b.completed_at LIMIT 1),
          (SELECT COALESCE(b.completed_at, b.created_at) FROM public.build_requests b WHERE b.app_id = a.app_id ORDER BY COALESCE(b.completed_at, b.created_at) DESC LIMIT 1), NULL)))), updated_at = now()
  FROM signals s WHERE a.app_id = s.app_id RETURNING a.app_id
)
DELETE FROM public.app_onboarding_refresh_jobs j USING refreshed r WHERE j.app_id = r.app_id AND j.batch_token = ${body.batchToken}::uuid
RETURNING j.app_id`)
    return result.rowCount ?? 0
  })
}
