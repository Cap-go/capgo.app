// Loads an app's published plugin state into the Cache API of the data center
// this worker runs in. Each regional plugin worker has a placement hint, so it
// runs in one data center and every device request of that region reads that
// data center's cache. Calling each regional hostname after a publication
// therefore warms the cache device requests will read (see
// triggers/updates_cache_purge.ts and the `app prewarm` CLI command).
//
// Unlike a device request, a prewarm waits for R2 and KV (bounded below): it
// runs off the device path, so it can absorb a slow provider read.

import type { KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc } from './pluginStateFormat.ts'
import { CacheHelper } from './cache.ts'
import { PLUGIN_STATE_CACHE } from './pluginState.ts'
import { isPluginStateGeneration, pluginStateAppKey, pluginStateImmutableKey, pluginStateManifestKey, pluginStateVersionKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStateShareBps } from './pluginStateSwitch.ts'
import { parsePluginStateApp, parsePluginStateManifestStorage, parsePluginStatePointer, parsePluginStateVersion } from './pluginStateValidation.ts'
import { pluginStateAppCacheTag } from './updatesCacheTag.ts'
import { backgroundTask, getEnv } from './utils.ts'

/** Each provider read of a prewarm (R2 pointer, pointer body, KV value), within the app's budget. */
export const PREWARM_READ_TIMEOUT_MS = 2000
/** Default total budget of one app when the caller sets none. */
export const PREWARM_APP_BUDGET_MS = 6000
/** Off the device path: a slow lookup is still worth waiting for before deciding to write. */
const PREWARM_CACHE_LOOKUP_TIMEOUT_MS = 500
/** How long a prewarm waits for its own cache write before handing it to the background. */
const PREWARM_CACHE_PUT_TIMEOUT_MS = 500
/** Budget of the background check that follows a write that finished late. */
const PREWARM_LATE_WRITE_CHECK_MS = 2000
/** Bundles warmed per app beside its app document (channel and rollout bundles). */
export const PREWARM_MAX_BUNDLES = 8

export interface PluginStatePrewarmResult {
  app_id: string
  /** Publication generation of the app document; null when none is published. */
  revision: string | null
  /** Documents confirmed written to this data center's cache. Current entries are kept. */
  cached: number
  skipped?: 'disabled' | 'unavailable' | 'unpublished' | 'budget'
  error?: string
}

interface Publication {
  value: unknown
  revision: string | null
}

/** One provider read, bounded by PREWARM_READ_TIMEOUT_MS and by what is left of `budgetEndsAt`. */
function deadline<T>(read: () => Promise<T>, what: string, budgetEndsAt: number): Promise<T> {
  const remaining = Math.min(PREWARM_READ_TIMEOUT_MS, budgetEndsAt - Date.now())
  if (remaining <= 0)
    return Promise.reject(new PluginStateMiss('prewarm budget exhausted'))
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    read(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PluginStateMiss(`${what} timed out`)), remaining)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Generation the R2 pointer publishes now (null: no pointer). */
async function readPublishedGeneration(pointers: R2Bucket, logicalKey: string, budgetEndsAt: number): Promise<string | null> {
  const object = await deadline(() => pointers.get(logicalKey), 'publication index', budgetEndsAt)
  if (!object)
    return null
  return parsePluginStatePointer(await deadline(() => object.json<unknown>(), 'publication index body', budgetEndsAt)).generation
}

/** The strongly consistent R2 pointer, then the immutable KV value it names. */
async function readPublication(pointers: R2Bucket, store: KVNamespace, logicalKey: string, budgetEndsAt: number): Promise<Publication> {
  const object = await deadline(() => pointers.get(logicalKey), 'publication index', budgetEndsAt)
  if (!object)
    return { value: null, revision: null }
  const pointer = parsePluginStatePointer(await deadline(() => object.json<unknown>(), 'publication index body', budgetEndsAt))
  if (pointer.kvKey === null)
    return { value: null, revision: pointer.generation }
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation))
    throw new PluginStateMiss('publication pointer identity mismatch')
  const kvKey = pointer.kvKey
  const value = await deadline(() => store.get<unknown>(kvKey, { type: 'json', cacheTtl: 30 }), 'published value', budgetEndsAt)
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision: pointer.generation }
}

interface WarmTarget<T> {
  layout: { path: string, ttlSeconds: number }
  params: Record<string, string>
  kvKey: string
  parse: (value: unknown) => T
}

/**
 * True when the cached entry may be replaced by a read of `published`.
 * Generations only grow, so an entry already holding the same or a newer
 * generation is kept: a slow prewarm never moves a cache back to older state.
 */
export function shouldReplaceCachedGeneration(current: string | null | undefined, published: string | null) {
  // No entry (undefined): a cold fill always writes.
  if (current === undefined)
    return true
  // Nothing published: never newer than what is cached.
  if (published === null)
    return false
  // A cached miss, or an entry without a readable generation.
  if (current === null || !isPluginStateGeneration(current))
    return true
  return BigInt(published) > BigInt(current)
}

/** Bundle id/name pairs served by the app's channels (current and rollout bundles). */
export function prewarmBundles(doc: PluginStateAppDoc): { id: number, name: string }[] {
  const bundles = new Map<number, string>()
  for (const row of doc.channels ?? []) {
    for (const version of [row.version, row.rolloutVersion]) {
      const id = Number(version?.id)
      if (Number.isSafeInteger(id) && id > 0 && typeof version.name === 'string' && version.name !== 'builtin' && !bundles.has(id))
        bundles.set(id, version.name)
    }
  }
  return [...bundles].slice(0, PREWARM_MAX_BUNDLES).map(([id, name]) => ({ id, name }))
}

/**
 * Warm one app in this data center: its app document, then the bundle-name
 * and manifest documents of the bundles its channels serve. A cache entry that
 * already holds the published generation is left untouched. Every provider
 * read stops at `budgetEndsAt` (epoch ms), so the caller's timeout holds.
 */
export async function prewarmPluginStateApp(c: Context, appId: string, budgetEndsAt = Date.now() + PREWARM_APP_BUDGET_MS): Promise<PluginStatePrewarmResult> {
  const store = (c.env as { PLUGIN_STATE?: KVNamespace } | undefined)?.PLUGIN_STATE
  const pointers = (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS
  if (!store || !pointers)
    return { app_id: appId, revision: null, cached: 0, skipped: 'unavailable' }
  // Reads off in this region: nothing would read the warmed entries.
  if (parsePluginStateShareBps(getEnv(c, 'PLUGIN_STATE_KV')) === 0)
    return { app_id: appId, revision: null, cached: 0, skipped: 'disabled' }

  const helper = new CacheHelper(c)
  const tags = [pluginStateAppCacheTag(appId)]
  let cached = 0
  const warm = async <T>(target: WarmTarget<T>, attempt = 0): Promise<{ value: T | null, revision: string | null }> => {
    const request = helper.buildRequest(target.layout.path, target.params)
    const published = await readPublication(pointers, store, target.kvKey, budgetEndsAt)
    const value = published.value === null ? null : target.parse(published.value)
    const current = await helper.probeResponse(request, PREWARM_CACHE_LOOKUP_TIMEOUT_MS)
    // Unknown cache state: an existing newer entry must not be overwritten blindly.
    if (current === undefined)
      throw new PluginStateMiss('cache lookup unavailable')
    const currentRevision = current ? current.headers.get(PLUGIN_STATE_CACHE.revisionHeader) : undefined
    void current?.body?.cancel().catch(() => undefined)
    if (!shouldReplaceCachedGeneration(currentRevision, published.revision))
      return { value, revision: published.revision }
    // Like a late refill, a prewarm can land after a purge: a miss gets the
    // document TTL, never the longer negative TTL of an on-time miss.
    // Unbounded here: the race below keeps hold of a write that finishes late.
    const put = helper.putJson(request, { v: value }, target.layout.ttlSeconds, {
      tags,
      headers: published.revision ? { [PLUGIN_STATE_CACHE.revisionHeader]: published.revision } : undefined,
    })
    const stored = await raceTimeout(put, Math.min(PREWARM_CACHE_PUT_TIMEOUT_MS, budgetEndsAt - Date.now()))
    if (stored === 'timeout') {
      // The write may still land, after this call returns. Check it then.
      void backgroundTask(c, put.then(landed => landed
        ? reconcile(request, target.kvKey, published.revision, Date.now() + PREWARM_LATE_WRITE_CHECK_MS)
        : undefined).catch(() => undefined))
      throw new PluginStateMiss('cache write timed out')
    }
    if (!stored)
      throw new PluginStateMiss('cache write failed')
    cached++
    // The Cache API has no conditional put, so a newer entry stored between the
    // lookup and this put could have been replaced. Such an entry comes from a
    // publication that is already visible in the strongly consistent pointer:
    // if the pointer moved past what was written, warm again with the newer one.
    const moved = await reconcile(request, target.kvKey, published.revision, budgetEndsAt)
    if (moved) {
      if (attempt >= 2)
        throw new PluginStateMiss('publication kept moving during the prewarm')
      return warm(target, attempt + 1)
    }
    return { value, revision: published.revision }
  }

  /**
   * After a write of `written`: false when the pointer still publishes it.
   * true when the pointer moved past it. When the pointer cannot be read, the
   * entry is deleted (a cold miss is safe, a stale entry is not) and this throws.
   * A pointer that moved also deletes the entry, so nothing stale is left even
   * when no retry follows.
   */
  const reconcile = async (request: Request, logicalKey: string, written: string | null, endsAt: number): Promise<boolean> => {
    let latest: string | null
    try {
      latest = await readPublishedGeneration(pointers, logicalKey, endsAt)
    }
    catch {
      await helper.delete(request)
      throw new PluginStateMiss('publication check after write unavailable')
    }
    const moved = latest !== null && (written === null || BigInt(latest) > BigInt(written))
    if (moved)
      await helper.delete(request)
    return moved
  }

  try {
    const app = await warm({ layout: PLUGIN_STATE_CACHE.app, params: { app_id: appId }, kvKey: await pluginStateAppKey(appId), parse: parsePluginStateApp })
    if (!app.value || app.value.app_id !== appId || !app.value.exists)
      return { app_id: appId, revision: app.revision, cached, skipped: app.value ? undefined : 'unpublished' }
    const manifestIds = new Set(app.value.manifest_ids ?? [])
    const bundles = prewarmBundles(app.value)
    const results = await Promise.allSettled(bundles.flatMap(bundle => [
      pluginStateVersionKey(appId, bundle.name).then(kvKey => warm({ layout: PLUGIN_STATE_CACHE.version, params: { app_id: appId, name: bundle.name }, kvKey, parse: parsePluginStateVersion })),
      ...(manifestIds.has(bundle.id)
        ? [warm({ layout: PLUGIN_STATE_CACHE.manifest, params: { app_id: appId, version_id: String(bundle.id) }, kvKey: pluginStateManifestKey(bundle.id), parse: parsePluginStateManifestStorage })]
        : []),
    ]))
    const failed = results.find(result => result.status === 'rejected')
    return { app_id: appId, revision: app.revision, cached, error: failed ? errorMessage(failed.reason) : undefined }
  }
  catch (error) {
    return { app_id: appId, revision: null, cached, error: errorMessage(error) }
  }
}

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  if (ms <= 0)
    return 'timeout'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'prewarm failed'
}
