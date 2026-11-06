// Writes the KV plugin state (plugin_runtime/utils/pluginState.ts) from the
// primary database. Statement-level triggers queue what changed in
// public.plugin_state_sync_pending (migration plugin_kv_state); each wake
// drains the queue in its own short transactions:
//   claim_plugin_state_sync() -> rebuild the KV keys -> ack_plugin_state_sync()
// then queues the existing edge cache purge, so the Cache API copies of the
// old documents leave every data center (with the purge pipeline's re-purges
// covering Workers KV propagation).
//
// Per app, in order: bundle-name keys, device override keys and manifests
// first, the app document last. The app document is the completion marker the
// plugin reads: a first (full) sync writes every key of the app before it, and
// resumes from a cursor when one wake cannot finish a large app.
//
// Runs in the Cloudflare API worker (PLUGIN_STATE binding). A runtime without
// the binding (Supabase functions) forwards the wake to CLOUDFLARE_FUNCTION_URL.

import type { KVNamespace } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc, PluginStateChannelRow, PluginStateDeviceDoc, PluginStateManifestDoc, PluginStatePlan, PluginStateStripe, PluginStateVersionDoc } from '../plugin_runtime/utils/pluginStateFormat.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import {
  PLUGIN_STATE_FORMAT,
  PLUGIN_STATE_INLINE_OVERRIDES_LIMIT,
  pluginStateAppKey,
  pluginStateDeviceKey,
  pluginStateDeviceKeyPrefix,
  pluginStateManifestKey,
  pluginStateVersionKey,
  pluginStateVersionKeyPrefix,
} from '../plugin_runtime/utils/pluginStateFormat.ts'
import { selectPluginStateChannelListIds, selectPluginStateChannels, selectPluginStateOwner } from '../plugin_runtime/utils/pluginStateSelects.ts'
import { updatesAppCacheTag, updatesVersionsCacheTag } from '../plugin_runtime/utils/updatesCacheTag.ts'
import { versionManifestRowsWithSizeSql } from '../plugin_runtime/utils/version_manifest_sql.ts'
import { BRES, middlewareAPISecret, parseBody } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { backgroundTask, getEnv } from '../utils/utils.ts'
import { purgeUpdatesCacheTags } from './updates_cache_purge.ts'

/** Stay inside the 30s waitUntil budget; the cron tick picks up the rest. */
const DRAIN_BUDGET_MS = 20_000
/** A full sync past this resumes on the next claim (cursor in the queue row). */
const APP_BUDGET_MS = 8_000
const CLAIM_LIMIT = 4
const APP_CONCURRENCY = 4
const KV_CONCURRENCY = 32
/** Eight simultaneous 5k-file bundles across four apps stay within Worker memory. */
const MANIFEST_CONCURRENCY = 2
const PAGE_SIZE = 128
/** Leave room for SQL, purge requests and connection cleanup below the 1,000-operation limit. */
const KV_OPERATION_BUDGET = 800
const KV_LIST_LIMIT = 1000
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
  apps?: ClaimedApp[]
  has_more?: boolean
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
  error?: unknown
  /** No provider failure: release the untouched work when this invocation is full. */
  deferred?: boolean
}

export function getPluginStateStore(c: SyncContext): KVNamespace | null {
  return (c.env as { PLUGIN_STATE?: KVNamespace } | undefined)?.PLUGIN_STATE ?? null
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

/** One invocation shares a budget and never mutates one key twice. App leases
 * and the SQL cooldown keep separate invocations at least one second apart. */
function createSyncStore(namespace: KVNamespace) {
  let remaining = KV_OPERATION_BUDGET
  const written = new Set<string>()
  function reserve() {
    if (remaining <= 0)
      throw new KvBudgetExhausted('plugin state KV operation budget exhausted')
    remaining--
  }
  return {
    get remaining() { return remaining },
    async getApp(key: string) {
      reserve()
      return namespace.get<PluginStateAppDoc>(key, { type: 'json' })
    },
    async list(options: { prefix: string, cursor?: string, limit: number }) {
      reserve()
      return namespace.list(options)
    },
    async delete(key: string) {
      if (written.has(key))
        return
      reserve()
      await namespace.delete(key)
      written.add(key)
    },
    async putJson(key: string, value: unknown) {
      if (written.has(key))
        return
      reserve()
      await namespace.put(key, JSON.stringify(value))
      written.add(key)
    },
  }
}

type SyncStore = ReturnType<typeof createSyncStore>

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

export async function buildManifestDoc(db: Db, versionId: number): Promise<PluginStateManifestDoc | null> {
  const [version] = await rows<{ id: string | number, app_id: string, deleted: boolean | null }>(db, sql`
    SELECT av.id, av.app_id, av.deleted FROM public.app_versions av WHERE av.id = ${versionId}::bigint`)
  if (!version)
    return null
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

async function syncManifests(db: Db, store: SyncStore, versionIds: number[]) {
  await runLimited(versionIds, MANIFEST_CONCURRENCY, async (versionId) => {
    const doc = await buildManifestDoc(db, versionId)
    if (doc)
      await putJson(store, pluginStateManifestKey(versionId), doc)
    else
      await store.delete(pluginStateManifestKey(versionId))
  })
}

export async function buildAppDoc(db: Db, appId: string, previousManifestIds: number[] = []): Promise<{ doc: PluginStateAppDoc, newManifestIds: number[] }> {
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
async function writeAppDoc(db: Db, store: SyncStore, appId: string) {
  const appKey = await pluginStateAppKey(appId)
  const previous = await store.getApp(appKey)
  const { doc, newManifestIds } = await buildAppDoc(db, appId, previous?.manifest_ids ?? [])
  if (newManifestIds.length > Math.min(MANIFEST_CONCURRENCY, Math.max(store.remaining - 1, 0)))
    return { doc, continuation: JSON.stringify({ p: 'manifests', after: null, revision: null }) }
  if (newManifestIds.length > 0)
    await syncManifests(db, store, newManifestIds)
  await putJson(store, appKey, doc)
  return { doc }
}

async function syncVersionNames(db: Db, store: SyncStore, appId: string, names: string[]) {
  const unique = [...new Set(names)]
  const found = await rows<{ id: string | number, owner_org: string, name: string, deleted: boolean | null }>(db, sql`
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

async function syncDevices(db: Db, store: SyncStore, appId: string, deviceIds: string[]) {
  const unique = [...new Set(deviceIds)]
  const found = await rows<{ device_id: string, channel_id: string | number }>(db, sql`
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
      await store.delete(key)
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

/** Decodes the names of listed keys (hashed long keys cannot be decoded and are left alone). */
function listedNames(keys: { name: string }[], prefix: string) {
  return keys
    .map(key => key.name.slice(prefix.length))
    .filter(rest => rest !== '' && !rest.startsWith('#'))
    .map((rest) => {
      try {
        return decodeURIComponent(rest)
      }
      catch {
        return null
      }
    })
    .filter((name): name is string => name !== null)
}

/**
 * One step of an app's full sync: bundle names, device overrides, cleanup of
 * keys whose rows are gone, then the served manifests and the app document.
 * A missing app only gets the cleanup and a tombstone.
 */
async function fullSync(db: Db, store: SyncStore, appId: string, ref: string, deadline: number): Promise<{ done: boolean, removed: boolean, cursor?: string }> {
  const exists = (await rows<{ found: number }>(db, sql`SELECT 1 AS found FROM public.apps WHERE app_id = ${appId} LIMIT 1`)).length > 0
  let cursor = parseCursor(ref)
  if (!exists && (cursor.p === 'versions' || cursor.p === 'devices'))
    cursor = { p: 'clean_versions', cursor: null }

  while (Date.now() < deadline) {
    try {
      switch (cursor.p) {
      case 'versions': {
        const page = await rows<{ id: string | number, owner_org: string, name: string, deleted: boolean | null }>(db, sql`
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
        const page = await rows<{ device_id: string, channel_id: string | number }>(db, sql`
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
        const prefix = pluginStateVersionKeyPrefix(appId)
        const listed = await store.list({ prefix, cursor: cursor.cursor ?? undefined, limit: KV_LIST_LIMIT })
        const names = listedNames(listed.keys, prefix)
        const kept = exists && names.length > 0
          ? new Set((await rows<{ name: string }>(db, sql`SELECT av.name FROM public.app_versions av WHERE av.app_id = ${appId} AND av.name = ANY (${sql.param(names)}::text[])`)).map(row => row.name))
          : new Set<string>()
        await runLimited(names.filter(name => !kept.has(name)), KV_CONCURRENCY, async name => store.delete(await pluginStateVersionKey(appId, name)))
        cursor = listed.list_complete ? { p: 'clean_devices', cursor: null } : { p: 'clean_versions', cursor: listed.cursor }
        break
      }
      case 'clean_devices': {
        const prefix = pluginStateDeviceKeyPrefix(appId)
        const listed = await store.list({ prefix, cursor: cursor.cursor ?? undefined, limit: KV_LIST_LIMIT })
        const deviceIds = listedNames(listed.keys, prefix)
        const kept = exists && deviceIds.length > 0
          ? new Set((await rows<{ device_id: string }>(db, sql`SELECT cd.device_id FROM public.channel_devices cd WHERE cd.app_id = ${appId} AND cd.device_id = ANY (${sql.param(deviceIds)}::text[])`)).map(row => row.device_id))
          : new Set<string>()
        await runLimited(deviceIds.filter(deviceId => !kept.has(deviceId)), KV_CONCURRENCY, async deviceId => store.delete(await pluginStateDeviceKey(appId, deviceId)))
        cursor = listed.list_complete ? { p: 'manifests', after: null, revision: null } : { p: 'clean_devices', cursor: listed.cursor }
        break
      }
      case 'manifests': {
        const { doc } = await buildAppDoc(db, appId)
        const ids = doc.manifest_ids ?? []
        const revision = await manifestRevision(ids)
        const after = cursor.revision === revision ? cursor.after : null
        const progress = await syncPluginStateManifestPage({
          versionIds: ids,
          after,
          deadline,
          available: () => store.remaining,
          write: batch => syncManifests(db, store, batch),
        })
        cursor = progress.done
          ? { p: 'final', revision }
          : { p: 'manifests', after: progress.after, revision }
        if (!progress.done && progress.after === after)
          return { done: false, removed: false, cursor: JSON.stringify(cursor) }
        break
      }
      case 'final': {
        const { doc } = await buildAppDoc(db, appId)
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

async function isFullySynced(db: Db, appId: string) {
  const [row] = await rows<{ full_synced_at: string | null }>(db, sql`SELECT s.full_synced_at::text FROM public.plugin_state_sync_apps s WHERE s.app_id = ${appId}`)
  return Boolean(row?.full_synced_at)
}

async function syncApp(db: Db, store: SyncStore, item: ClaimedApp, deadline: number): Promise<AppOutcome> {
  const appId = item.app_id
  try {
    const refsOf = (kind: ClaimedApp['jobs'][number]['kind']) => item.jobs.filter(job => job.kind === kind).map(job => job.ref).filter(Boolean)
    const fullJobs = item.jobs.filter(job => job.kind === 'full')
    const versionNames = refsOf('version')
    const deviceIds = refsOf('device')
    const manifestIds = refsOf('manifest').map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
    const wantsApp = item.jobs.some(job => job.kind === 'app') || deviceIds.length > 0

    // Single keys first: they read the database now, so they are never older
    // than what a concurrent full sync wrote.
    if (versionNames.length > 0)
      await syncVersionNames(db, store, appId, versionNames)
    if (deviceIds.length > 0)
      await syncDevices(db, store, appId, deviceIds)
    if (manifestIds.length > 0)
      await syncManifests(db, store, manifestIds)

    if (fullJobs.length > 0 || (wantsApp && !(await isFullySynced(db, appId)))) {
      // A fresh request restarts the full sync; otherwise resume the cursor.
      const ref = fullJobs.length === 0 || fullJobs.some(job => !job.ref) ? '' : fullJobs[0].ref
      const result = await fullSync(db, store, appId, ref, deadline)
      if (!result.done)
        return { appId, ok: true, continuation: result.cursor, versionsChanged: true }
      return { appId, ok: true, fullDone: true, removed: result.removed, versionsChanged: true }
    }

    if (wantsApp) {
      const written = await writeAppDoc(db, store, appId)
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
  const result: PluginStateDrainResult = { claims: 0, apps: 0, failed: 0 }
  if (!namespace)
    return result
  const store = createSyncStore(namespace)
  const deadline = Date.now() + (options.budgetMs ?? DRAIN_BUDGET_MS)
  // A later claim in this invocation must not acknowledge new changes to an
  // app whose keys the invocation's deduplication set has already written.
  const processedApps = new Set<string>()
  let pg: Awaited<ReturnType<typeof getPgClient>> | null = null
  try {
    pg = await getPgClient(c)
    const db = getDrizzleClient(pg, { logger: false })
    let busyRetries = 0
    while (Date.now() < deadline && store.remaining > 0) {
      const claimed = await claim(db)
      if (claimed.status === 'busy') {
        if (++busyRetries > MAX_BUSY_RETRIES)
          break
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      busyRetries = 0
      if (claimed.status !== 'ok' || !claimed.apps?.length || !claimed.lease_token)
        break
      result.claims++

      const appDeadline = Math.min(deadline, Date.now() + APP_BUDGET_MS)
      const outcomes = await runLimited(claimed.apps, APP_CONCURRENCY, async (item): Promise<AppOutcome> => {
        if (processedApps.has(item.app_id))
          return { appId: item.app_id, ok: false, deferred: true }
        processedApps.add(item.app_id)
        return syncApp(db, store, item, appDeadline)
      })
      const done = outcomes.filter(outcome => outcome.ok)
      const failed = outcomes.filter(outcome => !outcome.ok && !outcome.deferred)
      const deferred = outcomes.filter(outcome => outcome.deferred)
      for (const outcome of failed)
        cloudlogErr({ requestId: c.get('requestId'), message: 'plugin state sync failed', app_id: outcome.appId, error: serializeError(outcome.error) })

      // Continuations are queued before the ack, unleased: they survive it.
      const continuations = done.filter(outcome => outcome.continuation !== undefined)
      if (continuations.length > 0) {
        await db.execute(sql`SELECT public.notify_plugin_state_sync('full', ${sql.param(continuations.map(outcome => outcome.appId))}::text[], ${sql.param(continuations.map(outcome => outcome.continuation ?? ''))}::text[])`)
      }
      await db.execute(sql`SELECT public.ack_plugin_state_sync(
        p_lease_token => ${claimed.lease_token}::uuid,
        p_done => ${sql.param(done.map(outcome => outcome.appId))}::text[],
        p_failed => ${sql.param(failed.map(outcome => outcome.appId))}::text[],
        p_deferred => ${sql.param(deferred.map(outcome => outcome.appId))}::text[],
        p_retry_after_seconds => 10,
        p_full_done => ${sql.param(done.filter(outcome => outcome.fullDone && !outcome.removed).map(outcome => outcome.appId))}::text[],
        p_removed => ${sql.param(done.filter(outcome => outcome.removed).map(outcome => outcome.appId))}::text[]
      )`)
      result.apps += done.length
      result.failed += failed.length

      const appIds = done.map(outcome => outcome.appId)
      const versionAppIds = done.filter(outcome => outcome.versionsChanged).map(outcome => outcome.appId)
      if (appIds.length > 0) {
        // The purge pipeline evicts the old copies everywhere and re-purges
        // after Workers KV propagation.
        await db.execute(sql`SELECT public.notify_updates_edge_cache_purge(${sql.param(appIds)}::text[], 'app')`)
        if (versionAppIds.length > 0)
          await db.execute(sql`SELECT public.notify_updates_edge_cache_purge(${sql.param(versionAppIds)}::text[], 'versions')`)
        if (options.purgeNow)
          await purgeUpdatesCacheTags(c, [...appIds.map(updatesAppCacheTag), ...versionAppIds.map(updatesVersionsCacheTag)])
      }
      if (!claimed.has_more || deferred.length > 0)
        break
    }
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
  return !getPluginStateStore(c)
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
  if (!getPluginStateStore(c)) {
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
