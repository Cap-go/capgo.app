import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PublicDailyPlatformMetric, PublicLiveUpdateMetrics } from '../utils/public_live_update_metrics.ts'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { useCors } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { getPublicLiveUpdateMetricsCF } from '../utils/public_live_update_metrics.ts'
import { countAllApps, countAllUpdates, countAllUpdatesExternal } from '../utils/stats.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const WEBSITE_STATS_CACHE_TTL_SECONDS = 3600
const WEBSITE_STATS_CACHE_PATH = '/.public-website-stats'
const WEBSITE_STATS_HEADERS = {
  'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
}
export const WEBSITE_STATS_FALLBACK = {
  apps: 1688,
  updates: 1862788600,
  stars: 595,
} as const

const LIVE_UPDATE_METRICS_CACHE_TTL_SECONDS = 300
const LIVE_UPDATE_METRICS_CACHE_PATH = '/.public-live-update-metrics'
const LIVE_UPDATE_METRICS_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
}


function sanitizePublicPercent(value: number) {
  return Number(Number(value).toFixed(1))
}

function sanitizePublicRate(value: number | null | undefined) {
  if (value === null || value === undefined)
    return null
  return sanitizePublicPercent(value)
}

function sanitizePlatformRows(rows: PublicDailyPlatformMetric[]) {
  return rows.map(row => ({ date: row.date, ios: sanitizePublicRate(row.ios), android: sanitizePublicRate(row.android) }))
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
    first_try_rate: sanitizePublicRate(metrics.first_try_rate),
    first_day_rate: sanitizePublicRate(metrics.first_day_rate),
    first_day_success_rate: sanitizePublicRate(metrics.first_day_success_rate),
    rollback_rate: sanitizePublicRate(metrics.rollback_rate),
    zip_success_rate: sanitizePublicRate(metrics.zip_success_rate),
    delta_success_rate: sanitizePublicRate(metrics.delta_success_rate),
    period_days: metrics.period_days,
    daily_window_days: metrics.daily_window_days,
    updated_at: metrics.updated_at,
    daily: metrics.daily.map(row => ({
      date: row.date,
      success_rate: sanitizePublicPercent(row.success_rate),
    })),
    daily_platforms: sanitizePlatformRows(metrics.daily_platforms),
    daily_platforms_sparkline: sanitizePlatformRows(metrics.daily_platforms_sparkline),
    hourly_platforms: sanitizePlatformRows(metrics.hourly_platforms),
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

interface WebsiteStatsResponse {
  apps: number
  updates: number
  stars: number
}

async function getGithubStars(): Promise<number> {
  const response = await fetch('https://api.github.com/repos/Cap-go/capacitor-updater', {
    headers: {
      'User-Agent': 'capgo-app', // GitHub API requires a User-Agent
    },
  })
  if (!response.ok)
    throw new Error(`GitHub API error: HTTP ${response.status}`)
  const json = await response.json() as { stargazers_count?: number }
  return Number(json.stargazers_count ?? 0)
}

function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Website counters: unique Capgo apps (D1 store_apps + Postgres apps),
 * update downloads retained in Analytics Engine (app_log + sampled
 * app_log_external) and GitHub stars of the updater plugin. Each counter
 * falls back to the hardcoded value when its source is unavailable.
 */
async function computeWebsiteStats(c: Context): Promise<{ stats: WebsiteStatsResponse, complete: boolean }> {
  const [apps, updates, updatesExternal, stars] = await Promise.allSettled([
    countAllApps(c),
    countAllUpdates(c),
    countAllUpdatesExternal(c),
    getGithubStars(),
  ])
  const value = (result: PromiseSettledResult<number>) => result.status === 'fulfilled' && isPositiveCount(result.value) ? result.value : null

  const appsCount = value(apps)
  const updatesCount = value(updates)
  const updatesExternalCount = value(updatesExternal) ?? 0
  const starsCount = value(stars)
  const complete = appsCount !== null && updatesCount !== null && starsCount !== null
  if (!complete) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Website stats source unavailable, using fallback counters',
      apps: apps.status === 'rejected' ? serializeError(apps.reason) : apps.value,
      updates: updates.status === 'rejected' ? serializeError(updates.reason) : updates.value,
      stars: stars.status === 'rejected' ? serializeError(stars.reason) : stars.value,
    })
  }

  return {
    complete,
    stats: {
      apps: appsCount ?? WEBSITE_STATS_FALLBACK.apps,
      updates: updatesCount === null ? WEBSITE_STATS_FALLBACK.updates : updatesCount + updatesExternalCount,
      stars: starsCount ?? WEBSITE_STATS_FALLBACK.stars,
    },
  }
}

app.get('/', async (c) => {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(WEBSITE_STATS_CACHE_PATH)
  const cached = await cache.matchJson<WebsiteStatsResponse>(cacheKey)
  if (cached)
    return c.json(cached, 200, WEBSITE_STATS_HEADERS)

  try {
    const { stats, complete } = await computeWebsiteStats(c)
    if (!complete)
      return c.json(stats, 200, { 'Cache-Control': 'public, max-age=300' })
    await cache.putJson(cacheKey, stats, WEBSITE_STATS_CACHE_TTL_SECONDS)
    return c.json(stats, 200, WEBSITE_STATS_HEADERS)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Website stats failed, using fallback counters', error: serializeError(error) })
    return c.json({ ...WEBSITE_STATS_FALLBACK }, 200, { 'Cache-Control': 'public, max-age=300' })
  }
})

app.get('/live_updates', async (c) => {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(LIVE_UPDATE_METRICS_CACHE_PATH)
  let response = await cache.matchJson<PublicLiveUpdateMetrics>(cacheKey)

  if (!response) {
    try {
      response = sanitizePublicLiveUpdateMetrics(await getPublicLiveUpdateMetricsCF(c))
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
