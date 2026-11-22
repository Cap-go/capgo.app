// Fans a plugin state prewarm out to every regional plugin worker. Each one
// runs in a single data center (placement hint), so one call per regional
// hostname warms the cache that region's devices read. The hostname matters:
// cache keys include it, and the snippet sends devices to these hostnames.
// See plugin_runtime/utils/pluginStatePrewarm.ts.

import type { Context } from 'hono'
import type { PluginRegion } from './pluginRegionTargets.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getConfiguredPluginRegions, PLUGIN_REGIONS } from './pluginRegionTargets.ts'
import { backgroundTask, existInEnv, getEnv } from './utils.ts'

/** Same limit as the plugin route: one purge batch is one call per region. */
const PREWARM_APPS_PER_CALL = 100
const PREWARM_TIMEOUT_MS = 8000
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
 * runs never call production hostnames.
 */
export function pluginStatePrewarmTargets(c: Context): PluginRegion[] {
  if (existInEnv(c, 'PLUGIN_REGION_TARGETS'))
    return getConfiguredPluginRegions(c)
  return getEnv(c, 'ENV_NAME').endsWith('-prod') ? PLUGIN_REGIONS : []
}

async function prewarmRegion(region: PluginRegion, secret: string, appIds: string[]): Promise<RegionPrewarmResult> {
  const base = { region: region.name, status: null, placement: null, results: [] }
  try {
    const response = await fetch(`${new URL(region.url).origin}/plugin_state/prewarm`, {
      method: 'POST',
      headers: { 'apisecret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ app_ids: appIds }),
      signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { ...base, status: response.status, error: 'http_error' }
    }
    const body = await response.json() as { placement?: string | null, results?: RegionPrewarmResult['results'] }
    return { ...base, status: response.status, placement: body.placement ?? null, results: Array.isArray(body.results) ? body.results : [], error: null }
  }
  catch (error) {
    return { ...base, error: error instanceof Error ? error.message : 'prewarm failed' }
  }
}

/** Warm the given apps in every region; returns one entry per region and batch. */
export async function prewarmPluginStateRegions(c: Context, appIds: string[]): Promise<RegionPrewarmResult[]> {
  const targets = pluginStatePrewarmTargets(c)
  const secret = getEnv(c, 'API_SECRET')
  const unique = [...new Set(appIds)]
  if (!targets.length || !secret || !unique.length)
    return []
  const batches: string[][] = []
  for (let i = 0; i < unique.length; i += PREWARM_APPS_PER_CALL)
    batches.push(unique.slice(i, i + PREWARM_APPS_PER_CALL))
  const results = await Promise.all(batches.flatMap(batch => targets.map(region => prewarmRegion(region, secret, batch))))
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
      const failed = regions.filter(region => region.error !== null)
      cloudlog({
        requestId: c.get('requestId'),
        message: 'plugin state prewarmed',
        apps: new Set(appIds).size,
        regions: regions.length,
        failed: failed.map(region => `${region.region}:${region.error}`),
        cached: regions.reduce((sum, region) => sum + region.results.reduce((count, app) => count + (app.cached ?? 0), 0), 0),
      })
    })
    .catch(error => cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state prewarm failed', error: serializeError(error) }))
  void backgroundTask(c, run)
}
