// Fans a plugin state prewarm out to every regional plugin worker. Each one
// runs in a single data center (placement hint), so one call per regional
// hostname warms the cache that region's devices read. The hostname matters:
// cache keys include it, and the snippet sends devices to these hostnames.
// See plugin_runtime/utils/pluginStatePrewarm.ts.

import type { Context } from 'hono'
import type { PluginRegion } from './pluginRegionTargets.ts'
import { PREWARM_CALL_TIMEOUT_MS, PREWARM_MAX_APPS } from '../plugin_runtime/utils/pluginStatePrewarmLimits.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getConfiguredPluginRegions, PLUGIN_REGIONS } from './pluginRegionTargets.ts'
import { backgroundTask, existInEnv, getEnv } from './utils.ts'

/** Workers allow 6 simultaneous outbound connections; more would queue and eat their timeout. */
const PREWARM_CONNECTIONS = 6
/** Stay inside the 30 s waitUntil window that runs the background prewarm. */
const PREWARM_TOTAL_BUDGET_MS = 20_000
/** Let the zone purge reach every data center before refilling it. */
export const PREWARM_AFTER_PURGE_DELAY_MS = 1000

export interface RegionPrewarmResult {
  region: string
  status: number | null
  placement: string | null
  results: { app_id: string, revision: string | null, cached: number, skipped?: string, error?: string }[]
  error: string | null
}

/**
 * Regional plugin workers to warm. Production defaults to the known regions;
 * other environments only warm explicitly configured targets, so local and CI
 * runs do not call production hostnames by default. Invalid configured
 * targets disable the prewarm instead of failing the purge drain.
 */
export function pluginStatePrewarmTargets(c: Context): PluginRegion[] {
  if (existInEnv(c, 'PLUGIN_REGION_TARGETS')) {
    try {
      return getConfiguredPluginRegions(c)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state prewarm skipped: invalid PLUGIN_REGION_TARGETS', error: serializeError(error) })
      return []
    }
  }
  return getEnv(c, 'ENV_NAME').endsWith('-prod') ? PLUGIN_REGIONS : []
}

async function prewarmRegion(region: PluginRegion, secret: string, appIds: string[]): Promise<RegionPrewarmResult> {
  const base = { region: region.name, status: null, placement: null, results: [] }
  try {
    const response = await fetch(`${new URL(region.url).origin}/plugin_state/prewarm`, {
      method: 'POST',
      headers: { 'apisecret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ app_ids: appIds }),
      signal: AbortSignal.timeout(PREWARM_CALL_TIMEOUT_MS),
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { ...base, status: response.status, error: 'http_error' }
    }
    const body = await response.json() as { placement?: string | null, results?: RegionPrewarmResult['results'] }
    // Cloudflare sets cf-placement on responses of placed workers. Without it the
    // region is not pinned to one data center and its prewarm may miss device caches.
    const placement = response.headers.get('cf-placement') ?? body.placement ?? null
    return { ...base, status: response.status, placement, results: Array.isArray(body.results) ? body.results : [], error: null }
  }
  catch (error) {
    return { ...base, error: error instanceof Error ? error.message : 'prewarm failed' }
  }
}

/**
 * Warm the given apps in every region; returns one entry per batch and region,
 * in that order. Calls run through a pool sized to the connection limit, and a
 * call that could not finish inside the total budget is reported, not sent.
 */
export async function prewarmPluginStateRegions(c: Context, appIds: string[]): Promise<RegionPrewarmResult[]> {
  const targets = pluginStatePrewarmTargets(c)
  const secret = getEnv(c, 'API_SECRET')
  const unique = [...new Set(appIds)]
  if (!targets.length || !secret || !unique.length)
    return []
  const calls: { region: PluginRegion, batch: string[] }[] = []
  for (let i = 0; i < unique.length; i += PREWARM_MAX_APPS) {
    const batch = unique.slice(i, i + PREWARM_MAX_APPS)
    for (const region of targets)
      calls.push({ region, batch })
  }
  const lastStart = Date.now() + PREWARM_TOTAL_BUDGET_MS - PREWARM_CALL_TIMEOUT_MS
  const results: RegionPrewarmResult[] = Array.from({ length: calls.length })
  let next = 0
  await Promise.all(Array.from({ length: Math.min(PREWARM_CONNECTIONS, calls.length) }, async () => {
    while (next < calls.length) {
      const index = next++
      const { region, batch } = calls[index]
      results[index] = Date.now() <= lastStart
        ? await prewarmRegion(region, secret, batch)
        : { region: region.name, status: null, placement: null, results: [], error: 'budget_exhausted' }
    }
  }))
  return results
}

/**
 * Background prewarm after a successful plugin state purge. Never delays or
 * fails the purge drain; outcomes are only logged.
 */
export function schedulePluginStatePrewarm(c: Context, appIds: string[], delayMs = PREWARM_AFTER_PURGE_DELAY_MS) {
  if (!appIds.length || !pluginStatePrewarmTargets(c).length)
    return
  const run = new Promise(resolve => setTimeout(resolve, delayMs))
    .then(() => prewarmPluginStateRegions(c, appIds))
    .then((regions) => {
      // A region call can succeed while some of its apps failed or ran out of budget.
      const failed = regions.flatMap(region => region.error !== null
        ? [`${region.region}:${region.error}`]
        : region.results.filter(app => app.error || app.skipped === 'budget').map(app => `${region.region}:${app.app_id}:${app.error ?? app.skipped}`))
      cloudlog({
        requestId: c.get('requestId'),
        message: 'plugin state prewarmed',
        apps: new Set(appIds).size,
        regions: regions.length,
        failed: failed.slice(0, 20),
        failed_count: failed.length,
        cached: regions.reduce((sum, region) => sum + region.results.reduce((count, app) => count + (app.cached ?? 0), 0), 0),
      })
    })
    .catch(error => cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state prewarm failed', error: serializeError(error) }))
  void backgroundTask(c, run)
}
