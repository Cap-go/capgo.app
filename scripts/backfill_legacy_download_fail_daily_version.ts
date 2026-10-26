/*
 * Remove legacy download_fail from daily_version.fail.
 *
 * Updater plugins before 6.53.0 / 7.53.0 / 8.53.0 report a failed update check
 * as download_fail against the bundle the device already runs, and the stats
 * endpoint used to count it as a fail of that bundle. cron_stat_app now
 * subtracts them on read, but only refreshes the current billing cycle. This script recomputes every whole day still held by Analytics
 * Engine (89 days) from version_usage minus the legacy download_fail logs, the
 * same correction readStatsVersionCF applies. It only lowers counts and is
 * idempotent.
 *
 * Dry run:
 *   bun run admin:backfill-legacy-download-fail
 *
 * Apply:
 *   bun run admin:backfill-legacy-download-fail --apply
 *
 * Optional:
 *   --app-id=com.example.app
 *   --days=30
 *   --concurrency=4
 *   --env-file=./internal/cloudflare/.env.preprod
 */
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { escapeSqlString } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { legacyDownloadFailKey, legacyDownloadFailPluginSqlCF, sumLegacyDownloadFails } from '../supabase/functions/_backend/utils/legacyDownloadFail.ts'
import { asyncPool, createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, getRequiredEnv, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const DAY_MS = 86_400_000
const RETENTION_DAYS = 89
const DEFAULT_CONCURRENCY = 2
const MAX_RATE_LIMIT_RETRIES = 6
const DAILY_VERSION_PAGE_SIZE = 1000
const RESULT_OUTPUT = './tmp/legacy_download_fail_daily_version_backfill.json'
const DAY_BUCKET = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d')`

interface AnalyticsEngineConfig {
  accountId: string
  token: string
}

interface Change {
  app_id: string
  date: string
  version_name: string
  before: number
  after: number
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function formatDate(date: Date) {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

async function queryAnalyticsEngine<T>(config: AnalyticsEngineConfig, query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'text/plain; charset=utf-8' },
      body: query,
    })
    // Analytics Engine rate limits bursts of queries: back off and retry.
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await response.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000))
      continue
    }
    if (!response.ok)
      throw new Error(`Analytics Engine query failed (${response.status}): ${await response.text()}`)
    const json = await response.json() as { data?: T[] }
    return json.data ?? []
  }
}

async function readLegacyDownloadFails(config: AnalyticsEngineConfig, start: Date, end: Date, appId: string | null) {
  const appFilter = appId ? `AND index1 = '${escapeSqlString(appId)}'` : ''
  const byApp = new Map<string, Map<string, number>>()
  // One week per query keeps each response small.
  for (let from = start.getTime(); from < end.getTime(); from += 7 * DAY_MS) {
    const to = new Date(Math.min(from + 7 * DAY_MS, end.getTime()))
    const rows = await queryAnalyticsEngine<{ app_id: string, bucket: string, version_name: string, plugin_version: string, count: number | string }>(config, `SELECT
  index1 AS app_id,
  ${DAY_BUCKET} AS bucket,
  blob3 AS version_name,
  blob7 AS plugin_version,
  sum(_sample_interval) AS count
FROM app_log
WHERE
  blob2 = 'download_fail'
  AND ${legacyDownloadFailPluginSqlCF('blob7')}
  AND blob10 = ''
  AND timestamp >= toDateTime('${formatDate(new Date(from))}')
  AND timestamp < toDateTime('${formatDate(to)}')
  ${appFilter}
GROUP BY app_id, bucket, version_name, plugin_version`)
    const rowsByApp = Map.groupBy(rows, row => row.app_id)
    for (const [app, appRows] of rowsByApp) {
      const counts = byApp.get(app) ?? new Map<string, number>()
      for (const [key, count] of sumLegacyDownloadFails(appRows))
        counts.set(key, (counts.get(key) ?? 0) + count)
      byApp.set(app, counts)
    }
  }
  return byApp
}

async function readVersionFails(config: AnalyticsEngineConfig, appId: string, start: Date, end: Date) {
  const rows = await queryAnalyticsEngine<{ date: string, version_name: string, fail: number | string }>(config, `SELECT
  ${DAY_BUCKET} AS date,
  blob2 AS version_name,
  sum(if(blob3 = 'fail', _sample_interval, 0)) AS fail
FROM version_usage
WHERE
  index1 = '${escapeSqlString(appId)}'
  AND timestamp >= toDateTime('${formatDate(start)}')
  AND timestamp < toDateTime('${formatDate(end)}')
GROUP BY date, version_name`)
  return new Map(rows.map(row => [legacyDownloadFailKey(row.date, row.version_name), Number(row.fail)]))
}

export async function main() {
  const apply = process.argv.includes('--apply')
  const envFile = getArgValue(process.argv, '--env-file') ?? DEFAULT_ENV_FILE
  const appId = getArgValue(process.argv, '--app-id')
  const days = Math.min(parsePositiveInteger(getArgValue(process.argv, '--days'), '--days', RETENTION_DAYS), RETENTION_DAYS)
  const concurrency = parsePositiveInteger(getArgValue(process.argv, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)

  const env = { ...process.env, ...(await loadEnv(envFile)) }
  const config = { accountId: getRequiredEnv(env, 'CF_ACCOUNT_ANALYTICS_ID'), token: getRequiredEnv(env, 'CF_ANALYTICS_TOKEN') }
  const supabase = createSupabaseServiceClient(env)

  // Whole UTC days only: a day cut by retention or still running would be partial.
  const end = startOfUtcDay(new Date())
  const start = new Date(end.getTime() - days * DAY_MS)
  console.log(`${apply ? 'Applying' : 'Dry run'}: ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (exclusive)${appId ? ` for ${appId}` : ''}`)

  const legacyByApp = await readLegacyDownloadFails(config, start, end, appId)
  console.log(`${legacyByApp.size} apps have legacy download_fail logs`)

  const changes: Change[] = []
  const failures: Array<{ app_id: string, error: string }> = []
  await asyncPool(concurrency, [...legacyByApp.keys()], async (app) => {
    try {
      const legacy = legacyByApp.get(app)!
      const versionFails = await readVersionFails(config, app, start, end)
      for (let page = 0; ; page++) {
        const { data, error } = await supabase
          .from('daily_version')
          .select('date, version_name, fail')
          .eq('app_id', app)
          .gte('date', start.toISOString().slice(0, 10))
          .lt('date', end.toISOString().slice(0, 10))
          .order('date')
          .order('version_name')
          .range(page * DAILY_VERSION_PAGE_SIZE, (page + 1) * DAILY_VERSION_PAGE_SIZE - 1)
        if (error)
          throw error
        for (const row of data ?? []) {
          const key = legacyDownloadFailKey(row.date, row.version_name)
          const legacyFails = legacy.get(key)
          const recordedFails = versionFails.get(key)
          if (!legacyFails || recordedFails === undefined)
            continue
          // A stored day can hold fewer fails than Analytics Engine (last refreshed
          // before the day ended): only ever lower it, so a rerun changes nothing.
          const before = Number(row.fail ?? 0)
          const after = Math.min(before, Math.max(0, recordedFails - legacyFails))
          if (after !== before)
            changes.push({ app_id: app, date: row.date, version_name: row.version_name, before, after })
        }
        if ((data?.length ?? 0) < DAILY_VERSION_PAGE_SIZE)
          break
      }
    }
    catch (error) {
      failures.push({ app_id: app, error: error instanceof Error ? error.message : String(error) })
    }
  })

  if (apply) {
    await asyncPool(concurrency, changes, async (change) => {
      const { error } = await supabase
        .from('daily_version')
        .update({ fail: change.after })
        .eq('app_id', change.app_id)
        .eq('date', change.date)
        .eq('version_name', change.version_name)
      if (error)
        failures.push({ app_id: change.app_id, error: `${change.date} ${change.version_name}: ${error.message}` })
    })
  }

  const removed = changes.reduce((total, change) => total + change.before - change.after, 0)
  console.log(`${changes.length} daily_version rows ${apply ? 'updated' : 'to update'} across ${new Set(changes.map(change => change.app_id)).size} apps, ${removed} legacy fails removed`)
  await mkdir('./tmp', { recursive: true })
  await writeFile(RESULT_OUTPUT, `${JSON.stringify({ apply, start, end, changes, failures }, null, 2)}\n`)
  console.log(`Details written to ${RESULT_OUTPUT}`)
  if (failures.length > 0)
    throw new Error(`Legacy download_fail backfill finished with ${failures.length} failures`)
}

if (import.meta.main)
  await main()
