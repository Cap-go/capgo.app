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

/**
 * Prewarm calls in flight per invocation. Workers allow 6 simultaneous open
 * connections per invocation, and the purge drain that schedules prewarms
 * also holds its database socket and sends Cloudflare purge calls: prewarm
 * takes half, so a call never queues behind the drain after its timeout started.
 */
export const PREWARM_CONNECTIONS = 3

interface PrewarmSlots {
  open: number
  waiting: (() => void)[]
}

/**
 * Slots per invocation (keyed by its request): overlapping runs of one drain
 * share them, and an invocation that is cancelled cannot hold slots another
 * invocation waits for. A call's timeout only starts once it holds a slot.
 */
const prewarmSlots = new WeakMap<object, PrewarmSlots>()

async function withPrewarmConnection<T>(c: Context, run: () => Promise<T>): Promise<T> {
  const key = c.req.raw
  let slots = prewarmSlots.get(key)
  if (!slots) {
    slots = { open: 0, waiting: [] }
    prewarmSlots.set(key, slots)
  }
  if (slots.open < PREWARM_CONNECTIONS)
    slots.open++
  else
    await new Promise<void>(resolve => slots.waiting.push(resolve))
  try {
    return await run()
  }
  finally {
    // Hand the slot straight to the next waiting call, or free it.
    const next = slots.waiting.shift()
    if (next)
      next()
    else
      slots.open--
  }
}
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
      // Never follow a redirect: it would carry the API secret to another origin.
      redirect: 'manual',
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { ...base, status: response.status, error: 'http_error' }
    }
    const body = await response.json() as { placement?: string | null, results?: RegionPrewarmResult['results'] }
    // Cloudflare sets cf-placement on responses of placed workers. Without it the
    // region is not pinned to one data center and its prewarm may miss device caches.
    const placement = response.headers.get('cf-placement') ?? body.placement ?? null
    const results = Array.isArray(body.results) ? body.results : []
    // A 2xx answer must account for every requested app: a missing one did not prewarm.
    const answered = new Set(results.map(result => result.app_id))
    const missing = appIds.filter(appId => !answered.has(appId)).map(app_id => ({ app_id, revision: null, cached: 0, error: 'missing_result' }))
    return { ...base, status: response.status, placement, results: [...results, ...missing], error: null }
  }
  catch (error) {
    return { ...base, error: error instanceof Error ? error.message : 'prewarm failed' }
  }
}

/** Thrown when regions are configured but the API secret the regional route requires is not. */
export class PrewarmNotConfigured extends Error {
  constructor() {
    super('plugin state prewarm needs API_SECRET to call the regional workers')
    this.name = 'PrewarmNotConfigured'
  }
}

/**
 * Warm the given apps in every region; returns one entry per batch and region,
 * in that order. Calls run through a pool sized to the connection limit, and a
 * call that could not finish inside the total budget is reported, not sent.
 */
export async function prewarmPluginStateRegions(c: Context, appIds: string[]): Promise<RegionPrewarmResult[]> {
  const targets = pluginStatePrewarmTargets(c)
  const unique = [...new Set(appIds)]
  if (!targets.length || !unique.length)
    return []
  const secret = getEnv(c, 'API_SECRET')
  if (!secret)
    throw new PrewarmNotConfigured()
  const calls: { region: PluginRegion, batch: string[] }[] = []
  for (let i = 0; i < unique.length; i += PREWARM_MAX_APPS) {
    const batch = unique.slice(i, i + PREWARM_MAX_APPS)
    for (const region of targets)
      calls.push({ region, batch })
  }
  const lastStart = Date.now() + PREWARM_TOTAL_BUDGET_MS - PREWARM_CALL_TIMEOUT_MS
  return Promise.all(calls.map(({ region, batch }) => withPrewarmConnection(c, async (): Promise<RegionPrewarmResult> => Date.now() <= lastStart
    ? prewarmRegion(region, secret, batch)
    : { region: region.name, status: null, placement: null, results: [], error: 'budget_exhausted' })))
}

/** `region:error`, plus `:status` when the region answered (401 vs 5xx). */
function regionFailure(region: RegionPrewarmResult) {
  const status = region.status === null ? '' : `:${region.status}`
  return `${region.region}:${region.error}${status}`
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
        ? [regionFailure(region)]
        : region.results.filter(app => app.error || app.skipped === 'budget').map(app => `${region.region}:${app.app_id}:${app.error ?? app.skipped}`))
      // Answered without cf-placement: warmed a data center that may not be the
      // one its devices read (the region is not pinned).
      const unplaced = [...new Set(regions.filter(region => region.error === null && region.placement === null).map(region => region.region))]
      cloudlog({
        requestId: c.get('requestId'),
        message: 'plugin state prewarmed',
        apps: new Set(appIds).size,
        regions: regions.length,
        failed: failed.slice(0, 20),
        failed_count: failed.length,
        unplaced,
        cached: regions.reduce((sum, region) => sum + region.results.reduce((count, app) => count + (app.cached ?? 0), 0), 0),
      })
    })
    .catch(error => cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state prewarm failed', error: serializeError(error) }))
  void backgroundTask(c, run)
}
