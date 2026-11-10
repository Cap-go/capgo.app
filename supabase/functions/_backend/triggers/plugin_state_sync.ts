// Writes the KV plugin state (plugin_runtime/utils/pluginState.ts) from the
// primary database. Statement-level triggers queue what changed in
// public.plugin_state_sync_pending (migration plugin_kv_state); each wake
// drains the queue in its own short transactions:
//   claim_plugin_state_sync() -> rebuild the KV keys -> ack_plugin_state_sync()
// The acknowledgement durably queues the edge purge before deleting sync
// work, so the Cache API copies of the
// old documents leave every data center. Snapshot purges use an isolated tag
// and do not repeat the replica-lag ladder or evict the database cohort.
//
// Per app, in order: bundle-name keys, device override keys and manifests
// first, the app document last. The app document is the completion marker the
// plugin reads: a first (full) sync writes every key of the app before it, and
// resumes from a cursor when one wake cannot finish a large app.
//
// Runs in the Cloudflare API worker (PLUGIN_STATE binding). A runtime without
// the binding (Supabase functions) forwards the wake to CLOUDFLARE_FUNCTION_URL.

import type { KVNamespace, KVNamespacePutOptions, R2Bucket, R2Conditional, R2ListOptions } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc, PluginStateChannelRow, PluginStateDeviceDoc, PluginStateManifestDoc, PluginStateManifestFallbackDoc, PluginStatePlan, PluginStateStripe, PluginStateVersionDoc } from '../plugin_runtime/utils/pluginStateFormat.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import {
  PLUGIN_STATE_FORMAT,
  PLUGIN_STATE_INLINE_OVERRIDES_LIMIT,
  isPluginStateGeneration,
  pluginStateAppKey,
  pluginStateDeviceKey,
  pluginStateDeviceKeyPrefix,
  pluginStateImmutableKey,
  pluginStateManifestKey,
  pluginStateVersionKey,
  pluginStateVersionKeyPrefix,
} from '../plugin_runtime/utils/pluginStateFormat.ts'
import { parsePluginStateApp, parsePluginStatePointer } from '../plugin_runtime/utils/pluginStateValidation.ts'
import { selectPluginStateChannelListIds, selectPluginStateChannels, selectPluginStateOwner } from '../plugin_runtime/utils/pluginStateSelects.ts'
import { pluginStateAppCacheTag } from '../plugin_runtime/utils/updatesCacheTag.ts'
import { versionManifestRowsWithSizeSql } from '../plugin_runtime/utils/version_manifest_sql.ts'
import { BRES, middlewareAPISecret, parseBody } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { backgroundTask, getEnv } from '../utils/utils.ts'
import { purgeUpdatesCacheTags } from './updates_cache_purge.ts'

/** Stay inside the 30s waitUntil budget; the cron tick picks up the rest. */
const DRAIN_BUDGET_MS = 20_000
/** A full sync past this resumes on the next claim (cursor in the queue row). */
const APP_BUDGET_MS = 8_000
const CLAIM_LIMIT = 4
const APP_CONCURRENCY = 4
const KV_CONCURRENCY = 32
/** Small batches limit cursor replay; a separate invocation-wide gate bounds manifest memory. */
const MANIFEST_CONCURRENCY = 2
const PAGE_SIZE = 48
/** All KV and R2 operations share this cap, leaving room below the 1,000-operation limit. */
const PROVIDER_OPERATION_BUDGET = 800
const KV_LIST_LIMIT = 48
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024
/** Reserve headroom for rows, JS strings, document arrays, JSON encoding and Worker code. */
const MANIFEST_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024
const MAX_PUBLICATION_ATTEMPTS = 5
const IMMUTABLE_GC_AGE_MS = 24 * 60 * 60 * 1000
const IMMUTABLE_KEY_PREFIX = 'ps1:i:'
const MAX_BUSY_RETRIES = 40
const FORWARD_TIMEOUT_MS = 25_000
const FORWARDED_HEADER = 'x-capgo-plugin-state-forwarded'

type Db = ReturnType<typeof getDrizzleClient>
type SyncContext = Context<MiddlewareKeyVariables>

interface ClaimedApp {
  app_id: string
  jobs: { kind: 'app' | 'full' | 'device' | 'version' | 'manifest', ref: string }[]
  attempts: number
}

interface ClaimResult {
  status: 'busy' | 'empty' | 'ok'
  lease_token?: string
  generation?: string
  apps?: ClaimedApp[]
  has_more?: boolean
  retry_after_ms?: number
}

interface AppOutcome {
  appId: string
  ok: boolean
  /** A full sync finished (the app document is complete). */
  fullDone?: boolean
  /** The app no longer exists (tombstone written). */
  removed?: boolean
  /** Unfinished full sync: requeue with this cursor. */
  continuation?: string
  /** Bundle-name keys changed (purge the versions tag). */
  versionsChanged?: boolean
  changed?: boolean
  error?: unknown
  /** No provider failure: release the untouched work when this invocation is full. */
  deferred?: boolean
}

export function getPluginStateStore(c: SyncContext): KVNamespace | null {
  return (c.env as { PLUGIN_STATE?: KVNamespace } | undefined)?.PLUGIN_STATE ?? null
}

export function getPluginStatePointers(c: SyncContext): R2Bucket | null {
  return (c.env as { PLUGIN_STATE_POINTERS?: R2Bucket } | undefined)?.PLUGIN_STATE_POINTERS ?? null
}

async function rows<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query)
  return result.rows as T[]
}

async function runLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  })
  const settled = await Promise.allSettled(workers)
  const failure = settled.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected')
    throw failure.reason
  return results
}

class KvBudgetExhausted extends Error {}

export function createPluginStateWorkLimiter(limit: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (active < limit) {
        active++
        resolve()
      }
      else {
        waiting.push(resolve)
      }
    })
    try {
      return await work()
    }
    finally {
      const next = waiting.shift()
      if (next)
        next()
      else
        active--
    }
  }
}

/** This internal change-driven publisher materializes durable edge state. Each
 * source read uses a fresh, consistent primary snapshot rather than freezing a
 * previously cached SELECT into KV until the next change. Short transactions
 * release their checked-out connection before all KV/R2 work. Plugin requests
 * and the global Hyperdrive cache configuration are unchanged. */
export function createPluginStateSourceReader(c: SyncContext, deadline: number) {
  const sources = createPluginStateWorkLimiter(APP_CONCURRENCY)
  const manifests = createPluginStateWorkLimiter(1)
  return {
    async read<T>(run: (db: Db) => Promise<T>): Promise<T> {
      return sources(async () => {
        if (Date.now() >= deadline)
          throw new KvBudgetExhausted('plugin state snapshot deadline exhausted')
        const pg = await getPgClient(c)
        try {
          return await withPgTransaction(pg, client => run(getDrizzleClient(client, { logger: false })), {
            appendSql: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
          })
        }
        finally {
          closeClient(c, pg)
        }
      })
    },
    manifest: manifests,
  }
}

type SourceReader = ReturnType<typeof createPluginStateSourceReader>

function sourceRows<T>(source: SourceReader, query: ReturnType<typeof sql>) {
  return source.read(db => rows<T>(db, query))
}

interface PublicationBudget { remaining: number }
interface KvStore {
  get: (key: string, options: { type: 'json' }) => Promise<unknown>
  put: (key: string, value: string, options?: KVNamespacePutOptions) => Promise<void>
  delete: (key: string) => Promise<void>
  list: (options: { prefix: string, cursor?: string, limit: number }) => Promise<{
    keys: { name: string, metadata?: unknown }[]
    list_complete: boolean
    cursor?: string
  }>
}
interface PointerStore {
  get: (key: string) => Promise<{ etag: string, json: () => Promise<unknown>, customMetadata?: Record<string, string> } | null>
  put: (key: string, value: string, options: { onlyIf: R2Conditional, httpMetadata: { contentType: string }, customMetadata?: Record<string, string> }) => Promise<unknown | null>
  list: (options: R2ListOptions) => Promise<{ objects: { key: string, etag?: string, customMetadata?: Record<string, string> }[], truncated: boolean, cursor?: string }>
}

interface PublicationPrecondition { generation: string, etag: string, digest?: string }
interface ListedPointer { name: string, etag?: string, generation?: string, digest?: string }

/** Ignore the snapshot timestamp, while retaining every response-affecting field. */
async function publicationDigest(value: unknown) {
  const content = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'built_at'))
    : value
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

function pointerDigest(value: string | undefined) {
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined
}

function reserveProviderOperation(budget: PublicationBudget) {
  if (budget.remaining <= 0)
    throw new KvBudgetExhausted('plugin state provider operation budget exhausted')
  budget.remaining--
}

/** Immutable KV values plus an R2 compare-and-set pointer fence late writers.
 * A lease check alone cannot protect KV after an awaited operation or a lost
 * DB connection. No old generation can replace a newer R2 pointer, even if
 * the old Worker resumes after its lease expired. */
export function createPluginStateSyncStore(namespace: KvStore, pointers: PointerStore, generation: string, budget: PublicationBudget = { remaining: PROVIDER_OPERATION_BUDGET }) {
  const written = new Set<string>()
  let changed = false
  const reserve = () => reserveProviderOperation(budget)
  async function readPointer(key: string) {
    reserve()
    const object = await pointers.get(key)
    return object ? { value: parsePluginStatePointer(await object.json()), etag: object.etag, digest: pointerDigest(object.customMetadata?.digest) } : null
  }
  async function readPrecondition(key: string): Promise<PublicationPrecondition | null> {
    const pointer = await readPointer(key)
    return pointer ? { generation: pointer.value.generation, etag: pointer.etag, digest: pointer.digest } : null
  }
  async function publish(key: string, value: unknown, deleted: boolean, listed?: PublicationPrecondition) {
    if (written.has(key))
      return
    let previous = listed ?? await readPrecondition(key)
    if (previous && BigInt(previous.generation) >= BigInt(generation)) {
      written.add(key)
      return
    }
    const digest = await publicationDigest(deleted ? null : value)
    const kvKey = deleted ? null : await pluginStateImmutableKey(key, generation)
    if (kvKey !== null) {
      reserve()
      await namespace.put(kvKey, JSON.stringify(value), {
        metadata: { logical_key: key, generation, written_at: Date.now() },
      })
    }
    for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
      reserve()
      const object = await pointers.put(key, JSON.stringify({ f: 1, generation, kvKey }), {
        onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
        // R2 writes this metadata atomically with the pointer body. Cleanup
        // can use a strong listing's generation and ETag as its first CAS
        // precondition, without a separate GET for every historical key.
        customMetadata: { generation, digest },
      })
      if (object) {
        changed ||= previous?.digest !== digest
        written.add(key)
        return
      }
      previous = await readPrecondition(key)
      if (previous && BigInt(previous.generation) >= BigInt(generation)) {
        written.add(key)
        return
      }
    }
    throw new Error('plugin state pointer compare-and-set contention exceeded 5 attempts')
  }
  return {
    get remaining() { return budget.remaining },
    get changed() { return changed },
    async getApp(key: string) {
      const pointer = await readPointer(key)
      if (!pointer?.value.kvKey)
        return null
      reserve()
      const value = await namespace.get(pointer.value.kvKey, { type: 'json' })
      if (value === null)
        return null
      try {
        return parsePluginStateApp(value)
      }
      catch {
        // A corrupt previous document must not prevent the repair writer
        // from replacing it with a fresh primary-backed snapshot.
        return null
      }
    },
    async list(options: { prefix: string, cursor?: string, limit: number }) {
      reserve()
      const listed = await pointers.list({ ...options, include: ['customMetadata'] })
      if (listed.truncated && !listed.cursor)
        throw new Error('plugin state pointer listing has no continuation cursor')
      return {
        keys: listed.objects.map((object): ListedPointer => ({
          name: object.key,
          etag: object.etag,
          generation: isPluginStateGeneration(object.customMetadata?.generation) ? object.customMetadata.generation : undefined,
          digest: pointerDigest(object.customMetadata?.digest),
        })),
        list_complete: !listed.truncated,
        cursor: listed.cursor ?? '',
      }
    },
    delete: (key: string) => publish(key, null, true),
    deleteListed: (pointer: ListedPointer) => {
      const known = pointer.etag && isPluginStateGeneration(pointer.generation)
        ? { etag: pointer.etag, generation: pointer.generation, digest: pointer.digest }
        : undefined
      return publish(pointer.name, null, true, known)
    },
    putJson: (key: string, value: unknown) => publish(key, value, false),
  }
}

type SyncStore = ReturnType<typeof createPluginStateSyncStore>

function putJson(store: SyncStore, key: string, value: unknown) {
  return store.putJson(key, value)
}

// ---- Documents ------------------------------------------------------------

interface StripeRow {
  status: string | null
  trial_at: string | null
  trial_date: string | null
  mau_exceeded: boolean | null
  storage_exceeded: boolean | null
  bandwidth_exceeded: boolean | null
}

/** Plan inputs of buildPlanValidationExpression for the app owner. */
async function readPlan(db: Db, ownerOrg: string): Promise<PluginStatePlan> {
  const [org] = await rows<{ customer_id: string | null, has_credits: boolean }>(db, sql`
    SELECT o.customer_id, COALESCE((pg_catalog.to_jsonb(o) ->> 'has_usage_credits')::boolean, false) AS has_credits
    FROM public.orgs o
    WHERE o.id = ${ownerOrg}::uuid`)
  const customerId = org?.customer_id ?? null
  let stripe: PluginStateStripe | null = null
  if (customerId !== null) {
    const [row] = await rows<StripeRow>(db, sql`
      SELECT s.status, s.trial_at::text AS trial_at, (s.trial_at::date)::text AS trial_date,
        s.mau_exceeded, s.storage_exceeded, s.bandwidth_exceeded
      FROM public.stripe_info s
      WHERE s.customer_id = ${customerId}
      LIMIT 1`)
    stripe = row ?? null
  }
  return { has_credits: org?.has_credits === true, customer_id: customerId, stripe }
}

async function readInlineOverrides(db: Db, appId: string): Promise<Record<string, number> | null> {
  const overrides = await rows<{ device_id: string, channel_id: string | number }>(db, sql`
    SELECT cd.device_id, cd.channel_id
    FROM public.channel_devices cd
    WHERE cd.app_id = ${appId}
    LIMIT ${PLUGIN_STATE_INLINE_OVERRIDES_LIMIT + 1}`)
  if (overrides.length > PLUGIN_STATE_INLINE_OVERRIDES_LIMIT)
    return null
  // Null prototype: a "__proto__" device id must stay an own key.
  const map = Object.create(null) as Record<string, number>
  for (const override of overrides)
    map[override.device_id] = Number(override.channel_id)
  return map
}

/** Bundles the app's channels serve (main and rollout), the ones /updates loads manifests for. */
function servedVersionIds(channels: PluginStateChannelRow[]) {
  const ids = new Set<number>()
  for (const row of channels) {
    for (const version of [row.version, row.rolloutVersion]) {
      if (version?.id !== null && version?.id !== undefined)
        ids.add(Number(version.id))
    }
  }
  return [...ids]
}

function manifestFallback(version: { id: string | number, app_id: string }, reason: PluginStateManifestFallbackDoc['reason'] = 'kv_value_limit'): PluginStateManifestFallbackDoc {
  return {
    f: PLUGIN_STATE_FORMAT,
    built_at: Date.now(),
    app_id: version.app_id,
    version_id: Number(version.id),
    fallback: 'replica',
    reason,
  }
}

async function buildManifestDocSnapshot(db: Db, versionId: number): Promise<PluginStateManifestDoc | PluginStateManifestFallbackDoc | null> {
  const [version] = await rows<{ id: string | number, app_id: string, deleted: boolean | null }>(db, sql`
    SELECT av.id, av.app_id, av.deleted FROM public.app_versions av WHERE av.id = ${versionId}::bigint`)
  if (!version)
    return null
  // Aggregate in Postgres before buffering rows in the Worker. A valid
  // 10k-entry manifest with long paths can exceed both KV's 25MiB value cap
  // and the Worker memory budget when several builders run concurrently.
  // This conservative estimate includes JSON string escaping and duplicate
  // hashes in the sizes list; an oversize result never transfers the rows.
  const [size] = await rows<{ estimated_bytes: string | number }>(db, sql`
    SELECT COALESCE(SUM(
      pg_catalog.octet_length(pg_catalog.to_json(manifest.file_name)::text)
      + pg_catalog.octet_length(pg_catalog.to_json(manifest.s3_path)::text)
      + 2 * pg_catalog.octet_length(pg_catalog.to_json(manifest.file_hash)::text)
      + COALESCE(pg_catalog.octet_length(pg_catalog.to_json(manifest.file_size)::text), 4)
      + 128
    ), 0) + 4096 AS estimated_bytes
    FROM (${versionManifestRowsWithSizeSql(sql`${versionId}::bigint`)}) AS manifest`)
  const estimatedBytes = Number(size?.estimated_bytes ?? 0)
  if (estimatedBytes > KV_MAX_VALUE_BYTES)
    return manifestFallback(version)
  if (estimatedBytes > MANIFEST_MEMORY_LIMIT_BYTES)
    return manifestFallback(version, 'worker_memory_limit')
  const files = await rows<{ file_name: string, file_hash: string, s3_path: string, file_size: number | string | null, expected: number | string }>(
    db,
    versionManifestRowsWithSizeSql(sql`${versionId}::bigint`),
  )
  const complete = files.length > 0 && files.length === Number(files[0].expected)
  return {
    f: PLUGIN_STATE_FORMAT,
    built_at: Date.now(),
    version_id: Number(version.id),
    app_id: version.app_id,
    deleted: version.deleted,
    entries: complete ? files.map(file => ({ file_name: file.file_name, file_hash: file.file_hash, s3_path: file.s3_path })) : [],
    sizes: complete ? files.map(file => [file.file_hash, file.file_size === null ? null : String(file.file_size)] as [string, string | null]) : [],
  }
}

export function buildManifestDoc(source: SourceReader, versionId: number) {
  return source.read(db => buildManifestDocSnapshot(db, versionId))
}

/** The replica remains the source of truth for a valid manifest larger
 * than KV accepts. Publishing an explicit marker avoids poison retries and
 * replaces any previously cached smaller representation of this bundle. */
export function pluginStateManifestPublication(doc: PluginStateManifestDoc | PluginStateManifestFallbackDoc) {
  if ('fallback' in doc)
    return doc
  const serialized = JSON.stringify(doc)
  if (new TextEncoder().encode(serialized).byteLength <= KV_MAX_VALUE_BYTES)
    return doc
  return {
    f: PLUGIN_STATE_FORMAT,
    built_at: doc.built_at,
    app_id: doc.app_id,
    version_id: doc.version_id,
    fallback: 'replica',
    reason: 'kv_value_limit',
  }
}

async function syncManifests(source: SourceReader, store: SyncStore, versionIds: number[]) {
  await runLimited(versionIds, MANIFEST_CONCURRENCY, versionId => source.manifest(async () => {
    const doc = await buildManifestDoc(source, versionId)
    if (doc)
      await putJson(store, pluginStateManifestKey(versionId), pluginStateManifestPublication(doc))
    else
      await store.delete(pluginStateManifestKey(versionId))
  }))
}

async function buildAppDocSnapshot(db: Db, appId: string, previousManifestIds: number[] = []): Promise<{ doc: PluginStateAppDoc, newManifestIds: number[] }> {
  const owner = await selectPluginStateOwner(db, appId)
  if (!owner)
    return { doc: { f: PLUGIN_STATE_FORMAT, app_id: appId, built_at: Date.now(), exists: false }, newManifestIds: [] }
  const [plan, channels, overrides, channelListIds] = await Promise.all([
    readPlan(db, owner.owner_org),
    selectPluginStateChannels(db, appId),
    readInlineOverrides(db, appId),
    selectPluginStateChannelListIds(db, appId),
  ])
  const served = servedVersionIds(channels)
  const known = new Set(previousManifestIds)
  return {
    doc: {
      f: PLUGIN_STATE_FORMAT,
      app_id: appId,
      built_at: Date.now(),
      exists: true,
      owner: owner as PluginStateAppDoc['owner'],
      plan,
      channels,
      channel_list_ids: channelListIds,
      overrides,
      manifest_ids: served,
    },
    newManifestIds: served.filter(id => !known.has(id)),
  }
}

export function buildAppDoc(source: SourceReader, appId: string, previousManifestIds: number[] = []) {
  return source.read(db => buildAppDocSnapshot(db, appId, previousManifestIds))
}

/** A stable revision lets a multi-invocation manifest pass detect channel
 * changes before publishing an app document that references its results. */
async function manifestRevision(versionIds: number[]) {
  const canonical = [...new Set(versionIds)].sort((left, right) => left - right)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function pluginStateManifestPage(versionIds: number[], after: number | null, limit = PAGE_SIZE) {
  return [...new Set(versionIds)]
    .filter(id => after === null || id > after)
    .sort((left, right) => left - right)
    .slice(0, limit)
}

/** A manifest pass commits its cursor after each small batch. Both invocation
 * capacity and the wall-clock deadline can stop it without losing progress. */
export async function syncPluginStateManifestPage(options: {
  versionIds: number[]
  after: number | null
  deadline: number
  available: () => number
  write: (versionIds: number[]) => Promise<void>
}) {
  const page = pluginStateManifestPage(options.versionIds, options.after)
  let after = options.after
  let completed = 0
  for (let offset = 0; offset < page.length; offset += MANIFEST_CONCURRENCY) {
    const batch = page.slice(offset, offset + MANIFEST_CONCURRENCY)
    if (Date.now() >= options.deadline || options.available() < batch.length)
      return { after, done: false }
    try {
      await options.write(batch)
    }
    catch (error) {
      if (!(error instanceof KvBudgetExhausted))
        throw error
      return { after, done: false }
    }
    after = batch.at(-1)!
    completed += batch.length
  }
  return { after, done: completed === page.length && page.length < PAGE_SIZE }
}

/** Writes the app document, after the manifests of the bundles it serves.
 * Large rebuilds become a paginated full-sync continuation before any of
 * their manifests are written, so they cannot replay the same prefix forever. */
async function writeAppDoc(source: SourceReader, store: SyncStore, appId: string) {
  const appKey = await pluginStateAppKey(appId)
  const previous = await store.getApp(appKey)
  const { doc, newManifestIds } = await buildAppDoc(source, appId, previous?.manifest_ids ?? [])
  if (newManifestIds.length > Math.min(MANIFEST_CONCURRENCY, Math.max(store.remaining - 1, 0)))
    return { doc, continuation: JSON.stringify({ p: 'manifests', after: null, revision: null }) }
  if (newManifestIds.length > 0)
    await syncManifests(source, store, newManifestIds)
  await putJson(store, appKey, doc)
  return { doc }
}

async function syncVersionNames(source: SourceReader, store: SyncStore, appId: string, names: string[]) {
  const unique = [...new Set(names)]
  const found = await sourceRows<{ id: string | number, owner_org: string, name: string, deleted: boolean | null }>(source, sql`
    SELECT av.id, av.owner_org, av.name, av.deleted
    FROM public.app_versions av
    WHERE av.app_id = ${appId} AND av.name = ANY (${sql.param(unique)}::text[])`)
  const byName = new Map(found.map(row => [row.name, row]))
  await runLimited(unique, KV_CONCURRENCY, async (name) => {
    const key = await pluginStateVersionKey(appId, name)
    const row = byName.get(name)
    if (row)
      await putJson(store, key, { id: Number(row.id), owner_org: row.owner_org, deleted: row.deleted } satisfies PluginStateVersionDoc)
    else
      await store.delete(key)
  })
}

async function syncDevices(source: SourceReader, store: SyncStore, appId: string, deviceIds: string[]) {
  const unique = [...new Set(deviceIds)]
  const found = await sourceRows<{ device_id: string, channel_id: string | number }>(source, sql`
    SELECT cd.device_id, cd.channel_id
    FROM public.channel_devices cd
    WHERE cd.app_id = ${appId} AND cd.device_id = ANY (${sql.param(unique)}::text[])`)
  const byDevice = new Map(found.map(row => [row.device_id, row]))
  await runLimited(unique, KV_CONCURRENCY, async (deviceId) => {
    const key = await pluginStateDeviceKey(appId, deviceId)
    const row = byDevice.get(deviceId)
    if (row)
      await putJson(store, key, { channel_id: Number(row.channel_id) } satisfies PluginStateDeviceDoc)
    else
      await putJson(store, key, { channel_id: null } satisfies PluginStateDeviceDoc)
  })
}

// ---- Full sync --------------------------------------------------------------

const fullSyncCursorSchema = z.discriminatedUnion('p', [
  z.object({ p: z.literal('versions'), after: z.string().nullable() }),
  z.object({ p: z.literal('devices'), after: z.string().nullable() }),
  z.object({ p: z.literal('clean_versions'), cursor: z.string().nullable() }),
  z.object({ p: z.literal('clean_devices'), cursor: z.string().nullable() }),
  z.object({ p: z.literal('manifests'), after: z.number().int().nonnegative().nullable(), revision: z.string().nullable() }),
  z.object({ p: z.literal('final'), revision: z.string().optional() }),
])

type FullSyncCursor = z.infer<typeof fullSyncCursorSchema>

function parseCursor(ref: string): FullSyncCursor {
  if (ref) {
    try {
      const parsed = fullSyncCursorSchema.safeParse(JSON.parse(ref))
      if (parsed.success)
        return parsed.data
    }
    catch {
      // Unreadable cursor: start over.
    }
  }
  return { p: 'versions', after: null }
}

/** Keep each bounded listing entry with its decoded source identity. Hashed
 * long keys cannot be decoded and are left alone, as before. */
function listedReferences(keys: ListedPointer[], prefix: string) {
  return keys.flatMap((pointer) => {
    const rest = pointer.name.slice(prefix.length)
    if (!rest || rest.startsWith('#'))
      return []
    try {
      return [{ pointer, ref: decodeURIComponent(rest) }]
    }
    catch {
      return []
    }
  })
}

/**
 * One step of an app's full sync: bundle names, device overrides, cleanup of
 * keys whose rows are gone, then the served manifests and the app document.
 * A missing app only gets the cleanup and a tombstone.
 */
async function fullSync(source: SourceReader, store: SyncStore, appId: string, ref: string, deadline: number): Promise<{ done: boolean, removed: boolean, cursor?: string }> {
  const exists = (await sourceRows<{ found: number }>(source, sql`SELECT 1 AS found FROM public.apps WHERE app_id = ${appId} LIMIT 1`)).length > 0
  let cursor = parseCursor(ref)
  if (!exists && (cursor.p === 'versions' || cursor.p === 'devices'))
    cursor = { p: 'clean_versions', cursor: null }

  while (Date.now() < deadline) {
    try {
      switch (cursor.p) {
      case 'versions': {
        const page = await sourceRows<{ id: string | number, owner_org: string, name: string, deleted: boolean | null }>(source, sql`
          SELECT av.id, av.owner_org, av.name, av.deleted
          FROM public.app_versions av
          WHERE av.app_id = ${appId} AND (${cursor.after}::text IS NULL OR av.name > ${cursor.after}::text)
          ORDER BY av.name
          LIMIT ${PAGE_SIZE}`)
        await runLimited(page, KV_CONCURRENCY, async row => putJson(store, await pluginStateVersionKey(appId, row.name), { id: Number(row.id), owner_org: row.owner_org, deleted: row.deleted } satisfies PluginStateVersionDoc))
        cursor = page.length < PAGE_SIZE ? { p: 'devices', after: null } : { p: 'versions', after: page.at(-1)!.name }
        break
      }
      case 'devices': {
        const page = await sourceRows<{ device_id: string, channel_id: string | number }>(source, sql`
          SELECT cd.device_id, cd.channel_id
          FROM public.channel_devices cd
          WHERE cd.app_id = ${appId} AND (${cursor.after}::text IS NULL OR cd.device_id > ${cursor.after}::text)
          ORDER BY cd.device_id
          LIMIT ${PAGE_SIZE}`)
        await runLimited(page, KV_CONCURRENCY, async row => putJson(store, await pluginStateDeviceKey(appId, row.device_id), { channel_id: Number(row.channel_id) } satisfies PluginStateDeviceDoc))
        cursor = page.length < PAGE_SIZE ? { p: 'clean_versions', cursor: null } : { p: 'devices', after: page.at(-1)!.device_id }
        break
      }
      case 'clean_versions': {
        const prefix = await pluginStateVersionKeyPrefix(appId)
        const listed = await store.list({ prefix, cursor: cursor.cursor ?? undefined, limit: KV_LIST_LIMIT })
        const references = listedReferences(listed.keys, prefix)
        const names = references.map(entry => entry.ref)
        const kept = exists && names.length > 0
          ? new Set((await sourceRows<{ name: string }>(source, sql`SELECT av.name FROM public.app_versions av WHERE av.app_id = ${appId} AND av.name = ANY (${sql.param(names)}::text[])`)).map(row => row.name))
          : new Set<string>()
        await runLimited(references.filter(entry => !kept.has(entry.ref)), KV_CONCURRENCY, entry => store.deleteListed(entry.pointer))
        cursor = listed.list_complete ? { p: 'clean_devices', cursor: null } : { p: 'clean_versions', cursor: listed.cursor }
        break
      }
      case 'clean_devices': {
        const prefix = await pluginStateDeviceKeyPrefix(appId)
        const listed = await store.list({ prefix, cursor: cursor.cursor ?? undefined, limit: KV_LIST_LIMIT })
        const references = listedReferences(listed.keys, prefix)
        const deviceIds = references.map(entry => entry.ref)
        const kept = exists && deviceIds.length > 0
          ? new Set((await sourceRows<{ device_id: string }>(source, sql`SELECT cd.device_id FROM public.channel_devices cd WHERE cd.app_id = ${appId} AND cd.device_id = ANY (${sql.param(deviceIds)}::text[])`)).map(row => row.device_id))
          : new Set<string>()
        await runLimited(references.filter(entry => !kept.has(entry.ref)), KV_CONCURRENCY, entry => store.deleteListed(entry.pointer))
        cursor = listed.list_complete ? { p: 'manifests', after: null, revision: null } : { p: 'clean_devices', cursor: listed.cursor }
        break
      }
      case 'manifests': {
        const { doc } = await buildAppDoc(source, appId)
        const ids = doc.manifest_ids ?? []
        const revision = await manifestRevision(ids)
        const after = cursor.revision === revision ? cursor.after : null
        const progress = await syncPluginStateManifestPage({
          versionIds: ids,
          after,
          deadline,
          available: () => store.remaining,
          write: batch => syncManifests(source, store, batch),
        })
        cursor = progress.done
          ? { p: 'final', revision }
          : { p: 'manifests', after: progress.after, revision }
        if (!progress.done && progress.after === after)
          return { done: false, removed: false, cursor: JSON.stringify(cursor) }
        break
      }
      case 'final': {
        const { doc } = await buildAppDoc(source, appId)
        const revision = await manifestRevision(doc.manifest_ids ?? [])
        if (cursor.revision !== revision) {
          // Channel targets changed while this pass was running. Build their
          // artifacts before committing this newer app snapshot.
          cursor = { p: 'manifests', after: null, revision }
          break
        }
        await putJson(store, await pluginStateAppKey(appId), doc)
        return { done: true, removed: !doc.exists }
      }
      }
    }
    catch (error) {
      if (!(error instanceof KvBudgetExhausted))
        throw error
      // The cursor only advances after a whole page succeeds. Replaying its
      // completed prefix is safe after the app cooldown.
      break
    }
  }
  return { done: false, removed: false, cursor: JSON.stringify(cursor) }
}

// ---- Drain --------------------------------------------------------------------

async function readSyncStatus(source: SourceReader, appId: string) {
  const [row] = await sourceRows<{ fully_synced: boolean, pending_full: boolean, archived_full: boolean }>(source, sql`
    SELECT
      EXISTS (SELECT 1 FROM public.plugin_state_sync_apps WHERE app_id = ${appId} AND full_synced_at IS NOT NULL) AS fully_synced,
      EXISTS (SELECT 1 FROM public.plugin_state_sync_pending WHERE app_id = ${appId} AND kind = 'full') AS pending_full,
      EXISTS (SELECT 1 FROM public.plugin_state_sync_failed WHERE app_id = ${appId} AND kind = 'full') AS archived_full`)
  return row ?? { fully_synced: false, pending_full: false, archived_full: false }
}

async function syncApp(source: SourceReader, store: SyncStore, item: ClaimedApp, deadline: number): Promise<AppOutcome> {
  const appId = item.app_id
  try {
    const refsOf = (kind: ClaimedApp['jobs'][number]['kind']) => item.jobs.filter(job => job.kind === kind).map(job => job.ref).filter(Boolean)
    const fullJobs = item.jobs.filter(job => job.kind === 'full')
    const versionNames = refsOf('version')
    const deviceIds = refsOf('device')
    const manifestIds = refsOf('manifest').map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
    const wantsApp = item.jobs.some(job => job.kind === 'app') || deviceIds.length > 0
    const syncStatus = wantsApp && fullJobs.length === 0 ? await readSyncStatus(source, appId) : null
    // This also applies to repairs of previously completed apps. The old
    // completion marker must not let newer jobs overtake a cursor in backoff.
    if (syncStatus?.pending_full)
      return { appId, ok: false, deferred: true }
    const needsFull = fullJobs.length > 0 || Boolean(syncStatus && !syncStatus.fully_synced && !syncStatus.archived_full)

    // Single keys first: they read the database now, so they are never older
    // than what a concurrent full sync wrote.
    if (versionNames.length > 0)
      await syncVersionNames(source, store, appId, versionNames)
    if (deviceIds.length > 0)
      await syncDevices(source, store, appId, deviceIds)
    if (manifestIds.length > 0)
      await syncManifests(source, store, manifestIds)

    // A failed history scan must not freeze current channels, plan or app
    // deletion. Publish only the bounded app snapshot; missing independent
    // dependencies use replicas, without restarting manifest/history work.
    if (syncStatus?.archived_full) {
      if (wantsApp) {
        const { doc } = await buildAppDoc(source, appId)
        if (doc.exists)
          doc.manifest_ids = []
        await putJson(store, await pluginStateAppKey(appId), doc)
      }
      return { appId, ok: true, versionsChanged: versionNames.length > 0 }
    }

    if (needsFull) {
      // A fresh request restarts the full sync; otherwise resume the cursor.
      const ref = fullJobs.length === 0 || fullJobs.some(job => !job.ref) ? '' : fullJobs[0].ref
      const result = await fullSync(source, store, appId, ref, deadline)
      if (!result.done)
        return { appId, ok: true, continuation: result.cursor, versionsChanged: true }
      return { appId, ok: true, fullDone: true, removed: result.removed, versionsChanged: true }
    }

    if (wantsApp) {
      const written = await writeAppDoc(source, store, appId)
      if (written.continuation !== undefined)
        return { appId, ok: true, continuation: written.continuation, versionsChanged: versionNames.length > 0 }
      if (!written.doc.exists) {
        // Deleted app: clean its keys through a full sync (tombstone already written).
        return { appId, ok: true, continuation: '', versionsChanged: versionNames.length > 0 }
      }
    }
    return { appId, ok: true, versionsChanged: versionNames.length > 0 }
  }
  catch (error) {
    return { appId, ok: false, error, deferred: error instanceof KvBudgetExhausted }
  }
}

async function claim(db: Db): Promise<ClaimResult> {
  const [row] = await rows<{ result: ClaimResult }>(db, sql`SELECT public.claim_plugin_state_sync(p_limit => ${CLAIM_LIMIT}::integer) AS result`)
  return row?.result ?? { status: 'empty' }
}

const immutableMetadataSchema = z.object({
  logical_key: z.string().min(1).max(512),
  generation: z.string().refine(isPluginStateGeneration),
  written_at: z.number().finite(),
})

/** KV listing is restricted to maintenance. A key is garbage only after the
 * reader-cache grace period and a strong R2 read proves it is not current. */
export async function collectPluginStateGarbage(namespace: KvStore, pointers: PointerStore, options: {
  budget: PublicationBudget
  cursor: string | null
  deadline: number
  now?: number
}) {
  const startCursor = options.cursor
  const limit = Math.min(512, Math.floor((options.budget.remaining - 1) / 2))
  if (limit <= 0)
    return { cursor: startCursor, complete: false, deleted: 0 }
  reserveProviderOperation(options.budget)
  const listed = await namespace.list({ prefix: IMMUTABLE_KEY_PREFIX, cursor: startCursor ?? undefined, limit })
  const now = options.now ?? Date.now()
  let completed = true
  let deleted = 0
  await runLimited(listed.keys, KV_CONCURRENCY, async (key) => {
    if (Date.now() >= options.deadline) {
      completed = false
      return
    }
    const metadata = immutableMetadataSchema.safeParse(key.metadata)
    if (!metadata.success || metadata.data.written_at > now - IMMUTABLE_GC_AGE_MS)
      return
    if (key.name !== await pluginStateImmutableKey(metadata.data.logical_key, metadata.data.generation))
      return
    reserveProviderOperation(options.budget)
    const object = await pointers.get(metadata.data.logical_key)
    const pointer = object ? parsePluginStatePointer(await object.json()) : null
    if (!pointer || pointer.kvKey === key.name)
      return
    const order = BigInt(pointer.generation) - BigInt(metadata.data.generation)
    // A missing/older pointer may still be waiting for this candidate's
    // publisher. Only a newer pointer or same-generation tombstone proves
    // this immutable key can never become reachable in a future CAS.
    if (order < 0n || (order === 0n && pointer.kvKey !== null))
      return
    reserveProviderOperation(options.budget)
    await namespace.delete(key.name)
    deleted++
  })
  // If a deadline interrupted the page, replay it next time. Completed
  // deletions are idempotent and no unvisited key falls behind the cursor.
  return {
    cursor: completed ? (listed.list_complete ? null : listed.cursor ?? startCursor) : startCursor,
    complete: completed && listed.list_complete,
    deleted,
  }
}

async function drainPluginStateGarbage(db: Db, namespace: KvStore, pointers: PointerStore, budget: PublicationBudget, deadline: number) {
  const [claimed] = await rows<{ result: { lease_token: string, cursor: string | null } | null }>(db, sql`SELECT public.claim_plugin_state_gc() AS result`)
  if (!claimed?.result)
    return
  const progress = await collectPluginStateGarbage(namespace, pointers, { budget, deadline, cursor: claimed.result.cursor })
  await db.execute(sql`SELECT public.ack_plugin_state_gc(
    ${claimed.result.lease_token}::uuid, ${progress.cursor}::text, ${progress.complete}::boolean
  )`)
}

export interface PluginStateDrainResult {
  claims: number
  apps: number
  failed: number
}

/**
 * Claims, syncs and acknowledges batches until the queue is empty or the time
 * budget is spent. `purgeNow` also purges the edge cache tags directly (tests
 * and scripts wait for the sync to be visible).
 */
export async function drainPluginStateSync(c: SyncContext, options: { budgetMs?: number, purgeNow?: boolean } = {}): Promise<PluginStateDrainResult> {
  const namespace = getPluginStateStore(c)
  const pointers = getPluginStatePointers(c)
  const result: PluginStateDrainResult = { claims: 0, apps: 0, failed: 0 }
  if (!namespace || !pointers)
    return result
  const budget: PublicationBudget = { remaining: PROVIDER_OPERATION_BUDGET }
  const deadline = Date.now() + (options.budgetMs ?? DRAIN_BUDGET_MS)
  const source = createPluginStateSourceReader(c, deadline)
  let pg: Awaited<ReturnType<typeof getPgClient>> | null = null
  try {
    pg = await getPgClient(c)
    const db = getDrizzleClient(pg, { logger: false })
    let busyRetries = 0
    while (Date.now() < deadline && budget.remaining > 0) {
      const claimed = await claim(db)
      if (claimed.status === 'busy') {
        if (++busyRetries > MAX_BUSY_RETRIES)
          break
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      busyRetries = 0
      if (claimed.status !== 'ok' || !claimed.apps?.length || !claimed.lease_token) {
        const wait = claimed.retry_after_ms
        if (claimed.status === 'empty' && wait && wait > 0 && Date.now() + wait < deadline) {
          await new Promise(resolve => setTimeout(resolve, wait))
          continue
        }
        break
      }
      if (!claimed.generation)
        throw new Error('plugin state claim has no publication generation')
      result.claims++

      const appDeadline = Math.min(deadline, Date.now() + APP_BUDGET_MS)
      const outcomes = await runLimited(claimed.apps, APP_CONCURRENCY, async (item): Promise<AppOutcome> => {
        const store = createPluginStateSyncStore(namespace, pointers, claimed.generation!, budget)
        const outcome = await syncApp(source, store, item, appDeadline)
        // A prior attempt may have advanced a pointer without committing its
        // purge. Explicit reset repairs likewise invalidate conservatively.
        const retryOrReset = item.attempts > 1 || item.jobs.some(job => job.kind === 'full' && job.ref === '')
        return { ...outcome, changed: store.changed || retryOrReset }
      })
      const done = outcomes.filter(outcome => outcome.ok)
      const failed = outcomes.filter(outcome => !outcome.ok && !outcome.deferred)
      const deferred = outcomes.filter(outcome => outcome.deferred)
      for (const outcome of failed)
        cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state sync failed', app_id: outcome.appId, error: serializeError(outcome.error) })

      // ACK validates the lease and persists the next cursor atomically. A
      // stale drain must never enqueue an older continuation after replacement.
      const continuations = Object.fromEntries(done.filter(outcome => outcome.continuation !== undefined).map(outcome => [outcome.appId, outcome.continuation]))
      await db.execute(sql`SELECT public.ack_plugin_state_sync(
        p_lease_token => ${claimed.lease_token}::uuid,
        p_done => ${sql.param(done.map(outcome => outcome.appId))}::text[],
        p_failed => ${sql.param(failed.map(outcome => outcome.appId))}::text[],
        p_deferred => ${sql.param(deferred.map(outcome => outcome.appId))}::text[],
        p_retry_after_seconds => 10,
        p_full_done => ${sql.param(done.filter(outcome => outcome.fullDone && !outcome.removed).map(outcome => outcome.appId))}::text[],
        p_removed => ${sql.param(done.filter(outcome => outcome.removed).map(outcome => outcome.appId))}::text[],
        p_versions_changed => ${sql.param(done.filter(outcome => outcome.versionsChanged).map(outcome => outcome.appId))}::text[],
        p_changed_apps => ${sql.param(outcomes.filter(outcome => outcome.changed).map(outcome => outcome.appId))}::text[],
        p_continuations => ${JSON.stringify(continuations)}::jsonb
      )`)
      result.apps += done.length
      result.failed += failed.length

      const changedApps = outcomes.filter(outcome => outcome.changed).map(outcome => outcome.appId)
      // The isolated scope never invalidates database/control/snippet caches.
      if (options.purgeNow && changedApps.length > 0)
        await purgeUpdatesCacheTags(c, changedApps.map(pluginStateAppCacheTag))
      if ((!claimed.has_more && Object.keys(continuations).length === 0) || deferred.length > 0)
        break
    }
    if (Date.now() < deadline && budget.remaining >= 3)
      await drainPluginStateGarbage(db, namespace, pointers, budget, deadline)
  }
  catch (error) {
    result.failed++
    cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state sync drain failed', error: serializeError(error) })
  }
  finally {
    if (pg)
      closeClient(c, pg)
  }
  if (result.apps > 0 || result.failed > 0)
    cloudlog({ requestId: c.get('requestId'), message: 'plugin state synced', ...result })
  return result
}

export function shouldForwardPluginStateSync(c: SyncContext) {
  return (!getPluginStateStore(c) || !getPluginStatePointers(c))
    && Boolean(getEnv(c, 'CLOUDFLARE_FUNCTION_URL'))
    && c.req.header(FORWARDED_HEADER) !== '1'
}

async function forward(c: SyncContext, body: unknown) {
  return fetch(`${getEnv(c, 'CLOUDFLARE_FUNCTION_URL').replace(/\/$/, '')}/triggers/plugin_state_sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apisecret': getEnv(c, 'API_SECRET'), [FORWARDED_HEADER]: '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  })
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<{ wake?: boolean, drain?: boolean, apps?: unknown } | null>(c).catch(() => null) ?? {}
  if (!getPluginStateStore(c) || !getPluginStatePointers(c)) {
    if (!shouldForwardPluginStateSync(c))
      return c.json({ ...BRES, skipped: true })
    // No KV binding here (Supabase function): the Cloudflare API worker syncs.
    if (body.drain) {
      const response = await forward(c, body)
      return c.json(await response.json().catch(() => ({ ...BRES, forwarded: true })) as Record<string, unknown>, response.ok ? 200 : 502)
    }
    await backgroundTask(c, forward(c, body).then(response => response.body?.cancel()).catch((error: unknown) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state sync forward failed', error: serializeError(error) })
    }))
    return c.json({ ...BRES, forwarded: true })
  }

  const apps = Array.isArray(body.apps) ? body.apps.filter((value): value is string => typeof value === 'string' && value !== '') : []
  if (apps.length > 0) {
    const pg = await getPgClient(c)
    try {
      await getDrizzleClient(pg, { logger: false }).execute(sql`SELECT public.enqueue_plugin_state_full_sync(${sql.param(apps)}::text[])`)
    }
    finally {
      closeClient(c, pg)
    }
  }

  if (body.drain)
    return c.json({ ...BRES, ...await drainPluginStateSync(c, { purgeNow: true }) })

  // Answer the wake right away; the drain runs in the background.
  await backgroundTask(c, drainPluginStateSync(c))
  return c.json(BRES)
})
