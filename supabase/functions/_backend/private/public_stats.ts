import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PublicLiveUpdateMetrics } from '../utils/cloudflare.ts'
import { Hono } from 'hono/tiny'
import { REQUIRED_GLOBAL_STATS_SHARDS } from '../utils/global_stats.ts'
import { useCors } from '../utils/hono.ts'
import { CacheHelper } from '../utils/cache.ts'
import { getPublicLiveUpdateMetricsCF } from '../utils/cloudflare.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const LIVE_UPDATE_METRICS_CACHE_TTL_SECONDS = 300
const LIVE_UPDATE_METRICS_CACHE_PATH = '/.public-live-update-metrics'
const LIVE_UPDATE_METRICS_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
}

type LiveUpdateMetricsResponse = PublicLiveUpdateMetrics & {
  period_days: number
  updated_at: string
}

function sanitizePublicPercent(value: number) {
  return Number(Number(value).toFixed(1))
}

function sanitizeBreakdown(rows: PublicLiveUpdateMetrics['platforms']) {
  return rows.map(row => ({
    key: row.key,
    share: sanitizePublicPercent(row.share),
    success_rate: row.success_rate === null || row.success_rate === undefined
      ? null
      : sanitizePublicPercent(row.success_rate),
    top_failure: row.top_failure
      ? {
          reason: row.top_failure.reason,
          share: sanitizePublicPercent(row.top_failure.share),
        }
      : null,
  }))
}

/** Strip anything that is not a ratio/percent for the public /data page. */
export function sanitizePublicLiveUpdateMetrics(metrics: PublicLiveUpdateMetrics): PublicLiveUpdateMetrics {
  return {
    success_rate: sanitizePublicPercent(metrics.success_rate),
    daily: metrics.daily.map(row => ({
      date: row.date,
      success_rate: sanitizePublicPercent(row.success_rate),
    })),
    failures: metrics.failures.map(row => ({
      reason: row.reason,
      share: sanitizePublicPercent(row.share),
    })),
    platforms: sanitizeBreakdown(metrics.platforms),
    countries: sanitizeBreakdown(metrics.countries),
    updater_versions: sanitizeBreakdown(metrics.updater_versions),
  }
}


app.use('*', useCors)

export function getLatestCompletedGlobalStatsDateId(referenceDate = new Date()) {
  const completedDay = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate() - 1,
  ))

  return completedDay.toISOString().slice(0, 10)
}

app.get('/', async (c) => {
  const latestCompletedDateId = getLatestCompletedGlobalStatsDateId()
  const { data, error } = await supabaseAdmin(c)
    .from('global_stats')
    .select()
    .lte('date_id', latestCompletedDateId)
    .contains('completed_shards', [...REQUIRED_GLOBAL_STATS_SHARDS])
    .order('date_id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (data && !error) {
    return c.json({
      apps: data.apps,
      updates: (data.updates ?? 0) + (data.updates_external ?? 0),
      stars: data.stars,
    })
  }
  cloudlog({ requestId: c.get('requestId'), message: 'Missing completed global_stats row', latestCompletedDateId, error })
  return c.json({
    apps: 1688,
    updates: 1862788600,
    stars: 595,
  })
})

app.get('/live_updates', async (c) => {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(LIVE_UPDATE_METRICS_CACHE_PATH)
  let response = await cache.matchJson<LiveUpdateMetricsResponse>(cacheKey)

  if (!response) {
    try {
      const metrics = sanitizePublicLiveUpdateMetrics(await getPublicLiveUpdateMetricsCF(c))
      response = {
        period_days: 30,
        updated_at: new Date().toISOString(),
        ...metrics,
      }
      await cache.putJson(cacheKey, response, LIVE_UPDATE_METRICS_CACHE_TTL_SECONDS)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Public live update metrics are unavailable',
        error: serializeError(error),
      })
      return c.json(
        { error: 'Live update metrics are temporarily unavailable' },
        503,
        { 'Cache-Control': 'no-store' },
      )
    }
  }

  return c.json(response, 200, LIVE_UPDATE_METRICS_HEADERS)
})
