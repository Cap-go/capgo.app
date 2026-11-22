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
import { pluginStateAppKey, pluginStateImmutableKey, pluginStateManifestKey, pluginStateVersionKey } from './pluginStateFormat.ts'
import { PluginStateMiss } from './pluginStateRegistry.ts'
import { parsePluginStateShareBps } from './pluginStateSwitch.ts'
import { parsePluginStateApp, parsePluginStateManifestStorage, parsePluginStatePointer, parsePluginStateVersion } from './pluginStateValidation.ts'
import { pluginStateAppCacheTag } from './updatesCacheTag.ts'
import { getEnv } from './utils.ts'

/** Each provider read of a prewarm (R2 pointer, pointer body, KV value), within the app's budget. */
export const PREWARM_READ_TIMEOUT_MS = 2000
/** Default total budget of one app when the caller sets none. */
export const PREWARM_APP_BUDGET_MS = 6000
/** Bundles warmed per app beside its app document (channel and rollout bundles). */
export const PREWARM_MAX_BUNDLES = 8

export interface PluginStatePrewarmResult {
  app_id: string
  /** Publication generation of the app document; null when none is published. */
  revision: string | null
  /** Documents written to this data center's cache. Current entries are kept. */
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
  const warm = async <T>(target: WarmTarget<T>): Promise<{ value: T | null, revision: string | null }> => {
    const request = helper.buildRequest(target.layout.path, target.params)
    const published = await readPublication(pointers, store, target.kvKey, budgetEndsAt)
    const value = published.value === null ? null : target.parse(published.value)
    const current = await helper.matchResponse(request, { timeoutMs: PLUGIN_STATE_CACHE.matchTimeoutMs })
    const currentRevision = current?.headers.get(PLUGIN_STATE_CACHE.revisionHeader) ?? null
    void current?.body?.cancel().catch(() => undefined)
    if (current && published.revision !== null && currentRevision === published.revision)
      return { value, revision: published.revision }
    await helper.putJson(request, { v: value }, value === null ? PLUGIN_STATE_CACHE.negativeTtlSeconds : target.layout.ttlSeconds, {
      tags,
      timeoutMs: PLUGIN_STATE_CACHE.putTimeoutMs,
      headers: published.revision ? { [PLUGIN_STATE_CACHE.revisionHeader]: published.revision } : undefined,
    })
    cached++
    return { value, revision: published.revision }
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'prewarm failed'
}
