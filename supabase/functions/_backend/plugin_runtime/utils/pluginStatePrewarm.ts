// Loads an app's published plugin state into the Cache API of the data center
// this worker runs in. Each regional plugin worker has a placement hint, so it
// runs in one data center and every device request of that region reads that
// data center's cache. Calling each regional hostname after a publication
// therefore warms the cache device requests will read (see
// triggers/updates_cache_purge.ts and the `app prewarm` CLI command).
//
// Unlike a device request, a prewarm waits for R2 and KV (bounded below): it
// runs off the device path, so it can absorb a slow provider read.

import type { KVNamespace, R2Bucket, R2ObjectBody } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc, PluginStatePointer } from './pluginStateFormat.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import { PLUGIN_STATE_CACHE } from './pluginState.ts'
import { isPluginStateGeneration, pluginStateAppKey, pluginStateImmutableKey, pluginStateManifestKey, pluginStateVersionKey } from './pluginStateFormat.ts'
import { PREWARM_CLEANUP_RESERVE_MS, PREWARM_CONNECTIONS, PREWARM_MANIFEST_CONCURRENCY, PREWARM_MAX_OPERATIONS } from './pluginStatePrewarmLimits.ts'
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
  /**
   * Distinct documents whose cache write was accepted (cache.put resolved) and
   * reconciled. Cloudflare does not confirm storage on put, so this counts
   * accepted writes, not entries proven present. Current entries are kept.
   */
  cached: number
  skipped?: 'disabled' | 'unavailable' | 'unpublished' | 'budget'
  error?: string
}

interface Publication {
  value: unknown
  revision: string | null
}

/**
 * Budget of one prewarm call, shared by every app and retry in it: the
 * provider and cache operations it may still start (so even a publication that
 * keeps moving cannot push the call past the per-invocation operation limits),
 * and its manifest load slots (so large manifests cannot exhaust memory).
 */
interface Slots {
  open: number
  /** Each waiter takes a handed-off slot (true) or declines it once past its deadline (false). */
  waiting: (() => boolean)[]
}

export interface PrewarmOperations {
  used: number
  max: number
  /** Manifest loads (memory). */
  manifests: Slots
  /** R2, KV and Cache API operations in flight (invocation connections). */
  connections: Slots
}

export function prewarmOperations(max = PREWARM_MAX_OPERATIONS): PrewarmOperations {
  return { used: 0, max, manifests: { open: 0, waiting: [] }, connections: { open: 0, waiting: [] } }
}

/** Take a slot, waiting at most until `endsAt` (false: not admitted in time). */
function acquire(slots: Slots, limit: number, endsAt: number): Promise<boolean> {
  // Every admission checks the deadline, the free-slot path included.
  const wait = endsAt - Date.now()
  if (wait <= 0)
    return Promise.resolve(false)
  if (slots.open < limit) {
    slots.open++
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const admit = () => {
      clearTimeout(timer)
      // A handoff after the deadline is declined, and goes to the next waiter.
      const admitted = Date.now() < endsAt
      resolve(admitted)
      return admitted
    }
    const timer = setTimeout(() => {
      const index = slots.waiting.indexOf(admit)
      if (index >= 0)
        slots.waiting.splice(index, 1)
      resolve(false)
    }, wait)
    slots.waiting.push(admit)
  })
}

/** Hand the slot to the next waiter still within its deadline, or free it. */
function release(slots: Slots) {
  for (let next = slots.waiting.shift(); next; next = slots.waiting.shift()) {
    if (next())
      return
  }
  slots.open--
}

/** Slot primitives, exported for their unit tests only. */
export const prewarmSlotsForTests = { acquire, release }

/**
 * Run one manifest load once the call has a free manifest slot. `hold` keeps
 * the slot past `run` until a still-pending write (and any late check or
 * repair it triggers) settles: a timed-out write keeps its payload in memory,
 * so it must keep counting against the manifest limit.
 */
async function withManifestSlot<T>(ops: PrewarmOperations, endsAt: number, run: (hold: (pending: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  if (!await acquire(ops.manifests, PREWARM_MANIFEST_CONCURRENCY, endsAt))
    throw new PluginStateMiss('prewarm budget exhausted')
  let holders = 1
  const done = () => {
    holders--
    if (holders === 0)
      release(ops.manifests)
  }
  const hold = (pending: Promise<unknown>) => {
    holders++
    pending.then(done, done)
  }
  try {
    return await run(hold)
  }
  finally {
    done()
  }
}

function spend(ops: PrewarmOperations) {
  if (ops.used >= ops.max)
    throw new PluginStateMiss('prewarm operation budget exhausted')
  ops.used++
}

/**
 * Start one R2, KV or Cache API operation once the call holds a connection
 * slot (waiting no longer than `endsAt`), and keep the slot until the
 * operation settles, even after a caller stopped waiting for it.
 */
async function startOperation<T>(ops: PrewarmOperations, endsAt: number, operation: () => Promise<T>): Promise<{ running: Promise<T> }> {
  spend(ops)
  if (!await acquire(ops.connections, PREWARM_CONNECTIONS, endsAt))
    throw new PluginStateMiss('prewarm budget exhausted')
  // Through then(): a synchronous throw becomes a rejection, which still frees the slot.
  const running = Promise.resolve().then(operation)
  running.then(() => release(ops.connections), () => release(ops.connections))
  // Wrapped: an async function returning the promise itself would wait for it.
  return { running }
}

/**
 * One provider read. Its PREWARM_READ_TIMEOUT_MS timer starts once it holds a
 * connection slot, so queueing behind this call's own reads is not counted
 * against the provider; the whole read still stops at `budgetEndsAt`.
 */
async function deadline<T>(read: () => Promise<T>, what: string, budgetEndsAt: number, ops: PrewarmOperations, dispose?: (abandoned: T) => void): Promise<T> {
  if (budgetEndsAt - Date.now() <= 0)
    throw new PluginStateMiss('prewarm budget exhausted')
  const { running } = await startOperation(ops, budgetEndsAt, read)
  // A result that arrives after this read gave up is disposed (an R2 body is cancelled).
  const abandon = () => {
    void running.then(value => dispose?.(value), () => undefined)
  }
  const remaining = Math.min(PREWARM_READ_TIMEOUT_MS, budgetEndsAt - Date.now())
  if (remaining <= 0) {
    abandon()
    throw new PluginStateMiss('prewarm budget exhausted')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    running,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abandon()
        reject(new PluginStateMiss(`${what} timed out`))
      }, remaining)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Free an R2 object body nobody will read. */
function discardObject(object: R2ObjectBody | null) {
  void object?.body?.cancel().catch(() => undefined)
}

/** The pointer behind an R2 object; its body is cancelled when the read does not get to consume it. */
async function readPointerObject(pointers: R2Bucket, logicalKey: string, budgetEndsAt: number, ops: PrewarmOperations): Promise<PluginStatePointer | null> {
  const object = await deadline(() => pointers.get(logicalKey), 'publication index', budgetEndsAt, ops, discardObject)
  if (!object)
    return null
  try {
    return parsePluginStatePointer(await deadline(() => object.json<unknown>(), 'publication index body', budgetEndsAt, ops))
  }
  catch (error) {
    // Refused (no budget or slot) or timed out before the body was consumed.
    discardObject(object)
    throw error
  }
}

/** Generation the R2 pointer publishes now (null: no pointer). */
async function readPublishedGeneration(pointers: R2Bucket, logicalKey: string, budgetEndsAt: number, ops: PrewarmOperations): Promise<string | null> {
  return (await readPointerObject(pointers, logicalKey, budgetEndsAt, ops))?.generation ?? null
}

/** The strongly consistent R2 pointer, then the immutable KV value it names. */
async function readPublication(pointers: R2Bucket, store: KVNamespace, logicalKey: string, budgetEndsAt: number, ops: PrewarmOperations): Promise<Publication> {
  const pointer = await readPointerObject(pointers, logicalKey, budgetEndsAt, ops)
  if (!pointer)
    return { value: null, revision: null }
  if (pointer.kvKey === null)
    return { value: null, revision: pointer.generation }
  if (pointer.kvKey !== await pluginStateImmutableKey(logicalKey, pointer.generation))
    throw new PluginStateMiss('publication pointer identity mismatch')
  const kvKey = pointer.kvKey
  const value = await deadline(() => store.get<unknown>(kvKey, { type: 'json', cacheTtl: 30 }), 'published value', budgetEndsAt, ops)
  if (value === null)
    throw new PluginStateMiss('published value not propagated')
  return { value, revision: pointer.generation }
}

interface WarmTarget<T> {
  layout: { path: string, ttlSeconds: number }
  params: Record<string, string>
  kvKey: string
  parse: (value: unknown) => T
  /** Keeps the target's manifest slot until a pending write settles (manifests only). */
  hold?: (pending: Promise<unknown>) => void
}

/**
 * True when the cached entry may be replaced by a read of `published`.
 * Generations only grow, so an entry that this lookup sees holding the same or
 * a newer generation is kept. The lookup and the write are not atomic: a newer
 * entry stored in between is handled by the pointer check after the write
 * (see `reconcile` in prewarmPluginStateApp).
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
export async function prewarmPluginStateApp(c: Context, appId: string, budgetEndsAt = Date.now() + PREWARM_APP_BUDGET_MS, ops = prewarmOperations()): Promise<PluginStatePrewarmResult> {
  const store = (c.env as { PLUGIN_STATE?: KVNamespace } | undefined)?.PLUGIN_STATE
  const pointers = (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS
  if (!store || !pointers)
    return { app_id: appId, revision: null, cached: 0, skipped: 'unavailable' }
  // Reads off in this region: nothing would read the warmed entries.
  if (parsePluginStateShareBps(getEnv(c, 'PLUGIN_STATE_KV')) === 0)
    return { app_id: appId, revision: null, cached: 0, skipped: 'disabled' }

  const helper = new CacheHelper(c)
  const tags = [pluginStateAppCacheTag(appId)]
  /** Cache keys this call left holding the published generation (each counted once). */
  const warmed = new Set<string>()
  const notRemoved = '; entry not removed, it expires with its TTL'
  const removalPending = '; entry removal still pending'
  const removalSuffix = (removal: 'removed' | 'kept' | 'pending') => {
    if (removal === 'removed')
      return ''
    return removal === 'pending' ? removalPending : notRemoved
  }

  /**
   * Reads and writes stop PREWARM_CLEANUP_RESERVE_MS before `endsAt`, so a
   * cleanup delete always has time left inside the call budget.
   */
  const warm = async <T>(target: WarmTarget<T>, attempt: number, endsAt: number): Promise<{ value: T | null, revision: string | null }> => {
    const workEndsAt = endsAt - PREWARM_CLEANUP_RESERVE_MS
    const request = helper.buildRequest(target.layout.path, target.params)
    const published = await readPublication(pointers, store, target.kvKey, workEndsAt, ops)
    const value = published.value === null ? null : target.parse(published.value)
    // Unbounded underneath: the slot is held until cache.match really settles,
    // even when this lookup stops waiting for it.
    const { running: lookup } = await startOperation(ops, workEndsAt, () => helper.lookupResponse(request))
    const lookupMs = Math.min(PREWARM_CACHE_LOOKUP_TIMEOUT_MS, workEndsAt - Date.now())
    const looked = lookupMs > 0 ? await raceTimeout(lookup, lookupMs) : 'timeout'
    if (looked === 'timeout')
      void lookup.then(response => response?.body?.cancel()).catch(() => undefined)
    const current = looked === 'timeout' ? undefined : looked
    // Unknown cache state: an existing newer entry must not be overwritten blindly.
    if (current === undefined)
      throw new PluginStateMiss('cache lookup unavailable')
    const currentRevision = current ? current.headers.get(PLUGIN_STATE_CACHE.revisionHeader) : undefined
    void current?.body?.cancel().catch(() => undefined)
    if (!shouldReplaceCachedGeneration(currentRevision, published.revision))
      return { value, revision: published.revision }
    // No write starts once the budget is spent: it could only end as a timeout.
    if (workEndsAt - Date.now() <= 0)
      throw new PluginStateMiss('prewarm budget exhausted')
    // Like a late refill, a prewarm can land after a purge: a miss gets the
    // document TTL, never the longer negative TTL of an on-time miss.
    // Unbounded here: the race below keeps hold of a write that finishes late.
    const { running: put } = await startOperation(ops, workEndsAt, () => helper.putJson(request, { v: value }, target.layout.ttlSeconds, {
      tags,
      headers: published.revision ? { [PLUGIN_STATE_CACHE.revisionHeader]: published.revision } : undefined,
    }))
    target.hold?.(put)
    // No write may run past the budget's work window: it could only end as a timeout.
    const putMs = Math.min(PREWARM_CACHE_PUT_TIMEOUT_MS, workEndsAt - Date.now())
    const stored = putMs > 0 ? await raceTimeout(put, putMs) : 'timeout'
    if (stored === 'timeout') {
      // The write may still land, after this call returns. Check it then, and
      // when the pointer moved, overwrite it with the newer generation.
      const late = put.then(async (landed) => {
        const lateEndsAt = Date.now() + PREWARM_LATE_WRITE_CHECK_MS
        const check = landed ? await reconcile(request, target.kvKey, published.revision, lateEndsAt) : 'current'
        if (check !== 'current')
          await repair(target, attempt + 1, lateEndsAt, check)
      }).catch((error: unknown) => {
        // The response already reported the timeout: this log is the only trace.
        cloudlog({ requestId: c.get('requestId'), message: 'plugin state prewarm late write not reconciled', app_id: appId, document: target.layout.path, error: errorMessage(error) })
      })
      // A manifest keeps its slot through the late check and repair as well.
      target.hold?.(late)
      void backgroundTask(c, late)
      throw new PluginStateMiss('cache write timed out')
    }
    if (!stored)
      throw new PluginStateMiss('cache write failed')
    // The Cache API has no conditional put, so a newer entry stored between the
    // lookup and this put could have been replaced. Such an entry comes from a
    // publication that is already visible in the strongly consistent pointer:
    // if the pointer moved past what was written, warm again with the newer one.
    const check = await reconcile(request, target.kvKey, published.revision, endsAt)
    if (check !== 'current') {
      warmed.delete(request.url)
      return repair(target, attempt + 1, endsAt, check)
    }
    warmed.add(request.url)
    return { value, revision: published.revision }
  }

  /**
   * The pointer moved past a written entry. Writing the newer generation repairs
   * it even when its delete failed ('kept'). A delete still pending could remove
   * that newer write later, so no repair starts then. When the repair cannot
   * happen (retries spent, KV not propagated yet, budget gone), the error says
   * whether the stale entry was removed.
   */
  const repair = async <T>(target: WarmTarget<T>, attempt: number, endsAt: number, check: 'removed' | 'kept' | 'pending'): Promise<{ value: T | null, revision: string | null }> => {
    if (check === 'pending')
      throw new PluginStateMiss(`publication moved during the prewarm${removalPending}`)
    if (attempt > 2)
      throw new PluginStateMiss(`publication kept moving during the prewarm${check === 'kept' ? notRemoved : ''}`)
    try {
      return await warm(target, attempt, endsAt)
    }
    catch (error) {
      if (check === 'kept' && !errorMessage(error).endsWith(notRemoved))
        throw new PluginStateMiss(`${errorMessage(error).replace(/^plugin state missing: /, '')}${notRemoved}`)
      throw error
    }
  }

  /** Delete an entry, waiting no longer than `endsAt` allows. */
  const remove = async (request: Request, endsAt: number): Promise<'removed' | 'kept' | 'pending'> => {
    const started = await startOperation(ops, endsAt, () => helper.delete(request)).catch(() => null)
    // Never started (out of operations, or no slot before the deadline):
    // nothing is in flight, so the entry simply stays.
    if (!started)
      return 'kept'
    const removed = await raceTimeout(started.running, endsAt - Date.now())
    if (removed === 'timeout')
      return 'pending'
    return removed ? 'removed' : 'kept'
  }

  /**
   * After a write of `written`: 'current' when the pointer still publishes it.
   * When the pointer moved past it, the entry is deleted ('removed'; 'kept' if
   * the delete failed; 'pending' if it did not finish by `endsAt`) so nothing
   * stale is left even without a retry. When the pointer cannot be read, the
   * entry is deleted (a cold miss is safe, a stale entry is not) and this throws.
   */
  const reconcile = async (request: Request, logicalKey: string, written: string | null, endsAt: number): Promise<'current' | 'removed' | 'kept' | 'pending'> => {
    let latest: string | null
    try {
      latest = await readPublishedGeneration(pointers, logicalKey, endsAt - PREWARM_CLEANUP_RESERVE_MS, ops)
    }
    catch {
      // Neither the pointer nor the cache can be trusted: nothing else can
      // repair the entry, so it lives until its TTL (30 s) at most.
      warmed.delete(request.url)
      const removal = await remove(request, endsAt)
      throw new PluginStateMiss(`publication check after write unavailable${removalSuffix(removal)}`)
    }
    if (latest === null || (written !== null && BigInt(latest) <= BigInt(written)))
      return 'current'
    return remove(request, endsAt)
  }

  const warmTarget = <T>(target: WarmTarget<T>) => warm(target, 0, budgetEndsAt)
  try {
    const app = await warmTarget({ layout: PLUGIN_STATE_CACHE.app, params: { app_id: appId }, kvKey: await pluginStateAppKey(appId), parse: parsePluginStateApp })
    if (app.value?.app_id !== appId || !app.value.exists)
      return { app_id: appId, revision: app.revision, cached: warmed.size, skipped: app.value ? undefined : 'unpublished' }
    const manifestIds = new Set(app.value.manifest_ids ?? [])
    const bundles = prewarmBundles(app.value)
    // Bundle documents are only written, never used here: drop each value as
    // soon as it is cached, and load manifests through the call's slots.
    const results = await Promise.allSettled(bundles.flatMap(bundle => [
      pluginStateVersionKey(appId, bundle.name)
        .then(kvKey => warmTarget({ layout: PLUGIN_STATE_CACHE.version, params: { app_id: appId, name: bundle.name }, kvKey, parse: parsePluginStateVersion }))
        .then(() => undefined),
      ...(manifestIds.has(bundle.id)
        ? [withManifestSlot(ops, budgetEndsAt, hold => warmTarget({ layout: PLUGIN_STATE_CACHE.manifest, params: { app_id: appId, version_id: String(bundle.id) }, kvKey: pluginStateManifestKey(bundle.id), parse: parsePluginStateManifestStorage, hold }))
            .then(() => undefined)]
        : []),
    ]))
    const failed = results.find(result => result.status === 'rejected')
    return { app_id: appId, revision: app.revision, cached: warmed.size, error: failed ? errorMessage(failed.reason) : undefined }
  }
  catch (error) {
    return { app_id: appId, revision: null, cached: warmed.size, error: errorMessage(error) }
  }
}

/**
 * Run `run` over `items` with at most `limit` in flight, keeping the input
 * order in the results; the next item starts as soon as one finishes.
 */
export function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = (): Promise<void> => {
    if (next >= items.length)
      return Promise.resolve()
    const index = next++
    return run(items[index]).then((result) => {
      results[index] = result
    }).then(worker)
  }
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => results)
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
