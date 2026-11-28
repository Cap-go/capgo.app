import { servingCachePartition } from './servingPolicy.ts'
import type { KVNamespace } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc, PluginStateDeviceDoc, PluginStateManifestDoc, PluginStateManifestFallbackDoc, PluginStateVersionDoc } from './pluginStateFormat.ts'
import type { PluginStateQueries } from './pluginStateRegistry.ts'
import type { PluginStatePublication } from './pluginStateStore.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { createLazyPgClient, getDrizzleClient } from './pg.ts'
import {
  evalAppById,
  evalAppOwner,
  evalAppVersion,
  evalBlockProviderInfraRequests,
  evalChannelById,
  evalChannelByIdRollout,
  evalChannelDevice,
  evalChannelDeviceOverride,
  evalChannelDeviceRollout,
  evalChannelLookup,
  evalChannels,
  evalCompatibleChannels,
  evalDefaultChannel,
  evalDefaultChannelRollout,
  evalEffectiveChannel,
  evalMainChannels,
  evalManifestEntries,
} from './pluginStateEval.ts'
import { PLUGIN_STATE_FORMAT, pluginStateAppKey, pluginStateDeviceKey, pluginStateManifestKey, pluginStateVersionKey } from './pluginStateFormat.ts'
import { withPluginStateDocument } from './pluginStateReadBudget.ts'
import { bindPluginStateQueries, PluginStateColdMiss, PluginStateMiss } from './pluginStateRegistry.ts'
import { LATE_READ_TIMEOUT_MS, readPublishedGeneration, readPublishedPluginState } from './pluginStateStore.ts'
import { isPluginStateAuthoritative, isPluginStateStrict, markPluginStateServed, parsePluginStateShareBps, pluginStateBucket, unmarkPluginStateServed } from './pluginStateSwitch.ts'
import { parsePluginStateApp, parsePluginStateDevice, parsePluginStateManifestStorage, parsePluginStateVersion } from './pluginStateValidation.ts'
import { pluginStateAppCacheTag } from './updatesCacheTag.ts'
import { backgroundTask, getEnv } from './utils.ts'

/**
 * KV plugin state: /updates, /stats, /channel_self and /updates/manifest_size
 * answered without Postgres. triggers/plugin_state_sync writes the state from
 * the primary after every relevant change (pluginStateFormat.ts); this module
 * reads it and answers the pg.ts queries from it (pluginStateEval.ts), so the
 * endpoint code and its responses are unchanged.
 *
 * Reads: Cache API (per data center, reusing parsed isolate memory for the
 * same publication) -> R2 pointer -> immutable Workers KV value. Missing
 * independent dependencies fall back to the replica. A provider read that
 * misses its request deadline finishes in the background and refills the
 * Cache API, so later requests at that location are served from the cache.
 *
 * Rollout: worker secret `PLUGIN_STATE_KV` (off | on | N% of devices), one
 * stable decision per device. Unpublished apps always use the replica.
 * `PLUGIN_STATE_KV_AUTHORITATIVE=true` additionally trusts published deletion
 * pointers as missing apps; it never treats an absent pointer as a deletion.
 * `PLUGIN_STATE_KV_STRICT=true` (tests) fails any database access of a
 * request served from the state.
 */

const APP_CACHE_PATH = '/.plugin-state-app-v2'
const DEVICE_CACHE_PATH = '/.plugin-state-device-v2'
const VERSION_CACHE_PATH = '/.plugin-state-version-v2'
const MANIFEST_CACHE_PATH = '/.plugin-state-manifest-v2'
/**
 * Documents and misses stay cached until a publication replaces them. Every
 * publication durably queues a purge of the app's plugin-state tag, retried
 * until Cloudflare accepts it, and the prewarm then rewrites each region's
 * entries. A fill that raced the purge removes itself (reconcileDocument).
 * The TTL is only a backstop for an invalidation that never lands: a day keeps
 * provider reads to about one per document and region per day without a
 * publication, while bounding how long a lost purge could serve an old answer.
 * Cloudflare may evict idle entries sooner.
 */
const DOCUMENT_CACHE_TTL_SECONDS = 24 * 60 * 60
const APP_CACHE_TTL_SECONDS = DOCUMENT_CACHE_TTL_SECONDS
const VERSION_CACHE_TTL_SECONDS = DOCUMENT_CACHE_TTL_SECONDS
const MANIFEST_CACHE_TTL_SECONDS = DOCUMENT_CACHE_TTL_SECONDS
/** App documents can be large: allow more than the default 20ms Cache API read. */
const CACHE_MATCH_TIMEOUT_MS = 50
const CACHE_BODY_TIMEOUT_MS = 50
const REVISION_HEADER = 'X-Plugin-State-Revision'
const MEMORY_MAX_ENTRIES = 256
/** Conservative parsed-object estimate; avoid retaining hundreds of large manifests. */
const MEMORY_MAX_BYTES = 16 * 1024 * 1024
const MEMORY_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
export const PLUGIN_STATE_HEADER = 'X-Plugin-State'
const FORCE_HEADER = 'x-capgo-plugin-state'

export { isPluginStateMiss, PluginStateMiss } from './pluginStateRegistry.ts'

type AnyContext = Context<any>

function getStore(c: AnyContext): KVNamespace | null {
  return (c.env as { PLUGIN_STATE?: KVNamespace } | undefined)?.PLUGIN_STATE ?? null
}

export { isPluginStateAuthoritative }

function isLocalEnv(c: AnyContext) {
  return getEnv(c, 'ENV_NAME').endsWith('-local')
}



/**
 * Local test override: `x-capgo-plugin-state: kv | db` picks the path for
 * one request (differential tests and the speed comparison). Ignored outside
 * local workers.
 */
function forcedMode(c: AnyContext): 'kv' | 'db' | null {
  if (!isLocalEnv(c))
    return null
  const value = c.req.header(FORCE_HEADER)?.trim().toLowerCase()
  return value === 'kv' || value === 'db' ? value : null
}

/** True when this device's requests are served from the plugin state (before the document is read). */
export function shouldUsePluginState(c: AnyContext, appId: string, deviceId: string) {
  if (servingCachePartition(c))
    return false
  if (!getStore(c))
    return false
  const forced = forcedMode(c)
  if (forced)
    return forced === 'kv'
  const bps = parsePluginStateShareBps(getEnv(c, 'PLUGIN_STATE_KV'))
  return bps >= 10_000 || (bps > 0 && Boolean(deviceId) && pluginStateBucket(appId, deviceId) < bps)
}

interface CachedDoc<T> {
  revision: string | null
  value: T | null
}

const memory = new Map<string, CachedDoc<unknown> & { estimatedBytes: number }>()
let memoryBytes = 0
/** Background refills by Cache API URL: one provider read per document and isolate. */
const refills = new Map<string, Promise<void>>()

function rememberDoc(url: string, entry: CachedDoc<unknown>) {
  const previous = memory.get(url)
  if (previous)
    memoryBytes -= previous.estimatedBytes
  memory.delete(url)
  const estimatedBytes = JSON.stringify(entry.value).length * 4
  if (estimatedBytes > MEMORY_MAX_DOCUMENT_BYTES)
    return
  memory.set(url, { ...entry, estimatedBytes })
  memoryBytes += estimatedBytes
  while (memory.size > MEMORY_MAX_ENTRIES || memoryBytes > MEMORY_MAX_BYTES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined)
      break
    memoryBytes -= memory.get(oldest)?.estimatedBytes ?? 0
    memory.delete(oldest)
  }
}

/** Test hook. */
export function resetPluginStateMemory() {
  memory.clear()
  memoryBytes = 0
  refills.clear()
}

interface DocLoadOptions<T> {
  cachePath: string
  params: Record<string, string>
  kvKey: string
  tags: string[]
  ttlSeconds: number
  /** Large documents can reuse a parsed copy of the same immutable publication. */
  reuseParsed?: boolean
  parse: (value: unknown) => T
}

/**
 * One document: Cache API (reusing the parsed copy of the same publication),
 * then its R2 pointer and KV value. null: no live value is published.
 */
function loadDoc<T>(c: AnyContext, store: KVNamespace, options: DocLoadOptions<T>): Promise<T | null> {
  return loadDocWithRevision(c, store, options).then(doc => doc.value)
}

function loadDocWithRevision<T>(c: AnyContext, store: KVNamespace, options: DocLoadOptions<T>): Promise<CachedDoc<T>> {
  return withPluginStateDocument(c, options.kvKey, () => loadDocument(c, store, options))
}

async function readCachedEnvelope(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader)
    throw new Error('Cached plugin state has no body')
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    const decoder = new TextDecoder()
    const chunks: string[] = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        chunks.push(decoder.decode(value, { stream: true }))
      }
      chunks.push(decoder.decode())
      const envelope: unknown = JSON.parse(chunks.join(''))
      return envelope
    }
    finally {
      reader.releaseLock()
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => undefined)
          reject(new Error('Cached plugin state body timed out'))
        }, CACHE_BODY_TIMEOUT_MS)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function loadDocument<T>(c: AnyContext, store: KVNamespace, options: DocLoadOptions<T>): Promise<CachedDoc<T>> {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(options.cachePath, options.params)
  const cached = await helper.matchResponse(request, { timeoutMs: CACHE_MATCH_TIMEOUT_MS })
  if (cached) {
    const revision = cached.headers.get(REVISION_HEADER)
    const remembered = options.reuseParsed ? memory.get(request.url) as CachedDoc<T> | undefined : undefined
    if (remembered && revision && remembered.revision === revision) {
      void cached.body?.cancel().catch(() => undefined)
      return remembered
    }
    try {
      const envelope = await readCachedEnvelope(cached)
      if (!envelope || typeof envelope !== 'object' || !('v' in envelope))
        throw new Error('Invalid cached plugin state envelope')
      const value = envelope.v === null ? null : options.parse(envelope.v)
      if (options.reuseParsed && revision)
        rememberDoc(request.url, { revision, value })
      return { revision, value }
    }
    catch {
      // Unreadable entry: read KV again.
    }
  }

  // A concurrent request is already finishing this document's late read.
  if (refills.has(request.url))
    throw new PluginStateColdMiss('document refill in progress')
  // Assigned by the store callback; the cast keeps TypeScript from narrowing it to undefined.
  let late = undefined as { publication: Promise<PluginStatePublication>, sampledSince: number | null } | undefined
  let value: T | null
  let revision: string | null
  try {
    const published = await readPublishedPluginState(c, store, options.kvKey, (publication, sampledSince) => { late = { publication, sampledSince } })
    value = published.value === null ? null : options.parse(published.value)
    revision = published.revision
  }
  catch {
    if (late) {
      refillDocument(c, helper, request, options, late.publication, late.sampledSince)
      throw new PluginStateColdMiss('document still loading')
    }
    throw new PluginStateMiss('document unavailable or invalid')
  }
  if (options.reuseParsed && revision)
    rememberDoc(request.url, { revision, value })
  await backgroundTask(c, putDocument(c, helper, request, options, value, revision))
  return { revision, value }
}

/**
 * cached: stored and still current. superseded: a newer publication (or an
 * unreadable pointer) made it untrusted, and it was removed. stale: it could
 * not be removed either, and stays until the next purge or the TTL.
 */
type DocumentWrite = 'cached' | 'not_cached' | 'superseded' | 'stale'
/** Delete attempts for an entry the publication check cannot vouch for. */
const UNTRUSTED_ENTRY_DELETE_ATTEMPTS = 3

/**
 * Store a document (or a miss) and check it is still the published one. It
 * runs in the background, so it waits for the real write: a put that timed
 * out could still land later, after the check.
 */
async function putDocument<T>(c: AnyContext, helper: CacheHelper, request: Request, options: DocLoadOptions<T>, value: T | null, revision: string | null): Promise<DocumentWrite> {
  const stored = await helper.putJson(request, { v: value }, options.ttlSeconds, {
    tags: options.tags,
    headers: revision ? { [REVISION_HEADER]: revision } : undefined,
  })
  if (!stored)
    return 'not_cached'
  // Never rejects: the request that filled the cache must not fail on its check.
  return await reconcileDocument(c, helper, request, options.kvKey, revision).catch((): DocumentWrite => 'stale')
}

/** True when the generation published now is the stored one, or older. */
function isCurrentRevision(published: string | null, stored: string | null) {
  if (published === stored)
    return true
  return published !== null && stored !== null && BigInt(published) <= BigInt(stored)
}

/**
 * A fill that read the pointer just before a publication can land after that
 * publication's purge, and entries now outlive it. So after each write, read
 * the pointer again: R2 is strongly consistent, and the purge only follows a
 * pointer that is already visible. When the pointer moved past the stored
 * revision, or cannot be read, delete the entry: a cold miss is safe, a stale
 * entry is not. A failed delete is retried a bounded number of times, then
 * logged as an error: the entry then lives until the next purge or the TTL.
 */
async function reconcileDocument(c: AnyContext, helper: CacheHelper, request: Request, kvKey: string, revision: string | null): Promise<DocumentWrite> {
  const published = await Promise.resolve()
    .then(() => readPublishedGeneration(c, kvKey))
    .then(generation => ({ generation }), () => null)
  if (published && isCurrentRevision(published.generation, revision))
    return 'cached'
  // Parsed memory is only reused for the revision the cache entry holds, so it needs no cleanup.
  for (let attempt = 0; attempt < UNTRUSTED_ENTRY_DELETE_ATTEMPTS; attempt++) {
    if (await helper.delete(request))
      return 'superseded'
  }
  cloudlogErr({
    requestId: c.get('requestId'),
    message: 'plugin state cache entry not removed after its publication check',
    document: new URL(request.url).pathname,
    stored_revision: revision,
    published_revision: published ? published.generation : 'unreadable',
    attempts: UNTRUSTED_ENTRY_DELETE_ATTEMPTS,
  })
  return 'stale'
}

/**
 * Finish a read that missed the request deadline and cache it like an
 * on-time read. The request has already fallen back; this never delays it.
 */
function refillDocument<T>(c: AnyContext, helper: CacheHelper, request: Request, options: DocLoadOptions<T>, publication: Promise<PluginStatePublication>, sampledSince: number | null) {
  // Another request of this isolate registered a refill during this read.
  if (refills.has(request.url)) {
    void publication.catch(() => undefined)
    return
  }
  // Timing-sampled requests log how long the full provider read took, excluding the cache write.
  let readEndedAt: number | null = null
  const now = () => sampledSince === null ? 0 : performance.now()
  // not_cached: the read finished, but the best-effort cache write failed.
  // superseded / stale: written, then found untrusted, and removed / not removable (DocumentWrite).
  // write_pending: the write or its check was still running after LATE_READ_TIMEOUT_MS.
  const log = (outcome: DocumentWrite | 'write_pending' | 'failed') => {
    if (sampledSince === null)
      return
    cloudlog({
      requestId: c.get('requestId'),
      message: 'plugin_state_refill',
      document: options.cachePath,
      outcome,
      duration_ms: Math.round(((readEndedAt ?? now()) - sampledSince) * 100) / 100,
      colo: c.req.raw.cf?.colo ?? null,
    })
  }
  const refill = publication
    .then(async (published) => {
      readEndedAt = now()
      const value = published.value === null ? null : options.parse(published.value)
      if (options.reuseParsed && published.revision)
        rememberDoc(request.url, { revision: published.revision, value })
      const write = putDocument(c, helper, request, options, value, published.revision)
      // Keep the write and its publication check alive past this wait: they may finish after it.
      void backgroundTask(c, write)
      let timer: ReturnType<typeof setTimeout> | undefined
      const stored = await Promise.race([
        write,
        new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), LATE_READ_TIMEOUT_MS) }),
      ]).finally(() => clearTimeout(timer))
      log(stored === 'pending' ? 'write_pending' : stored)
    })
    .catch(() => log('failed'))
    .finally(() => {
      if (refills.get(request.url) === refill)
        refills.delete(request.url)
    })
  refills.set(request.url, refill)
  void backgroundTask(c, refill)
}

function loadAppDoc(c: AnyContext, store: KVNamespace, appId: string, kvKey: string) {
  return loadDocWithRevision<PluginStateAppDoc>(c, store, {
    cachePath: APP_CACHE_PATH,
    params: { app_id: appId },
    kvKey,
    tags: [pluginStateAppCacheTag(appId)],
    ttlSeconds: APP_CACHE_TTL_SECONDS,
    reuseParsed: true,
    parse: parsePluginStateApp,
  })
}

const sessions = new WeakMap<object, PluginStateSession | null>()

/**
 * Plugin state session of this request, decided once: null when the request
 * uses the database path (state off, device not sampled, app not synced yet).
 */
export async function startPluginStateRequest(c: AnyContext, appId: string, deviceId: string): Promise<PluginStateSession | null> {
  const store = getStore(c)
  if (!store || !appId)
    return null
  const known = sessions.get(c.req.raw)
  if (known !== undefined)
    return known
  if (!shouldUsePluginState(c, appId, deviceId)) {
    sessions.set(c.req.raw, null)
    return null
  }
  let published: CachedDoc<PluginStateAppDoc>
  try {
    published = await loadAppDoc(c, store, appId, await pluginStateAppKey(appId))
  }
  catch (error) {
    sessions.set(c.req.raw, null)
    // Expected until the background refill lands; the timing sample measures it.
    if (error instanceof PluginStateColdMiss) {
      setStateHeader(c, 'cold')
      return null
    }
    cloudlog({ requestId: c.get('requestId'), message: 'plugin state read failed, using the database', app_id: appId, error })
    setStateHeader(c, 'error')
    return null
  }
  const doc = published.value
  if (doc && doc.app_id !== appId) {
    sessions.set(c.req.raw, null)
    setStateHeader(c, 'error')
    return null
  }
  if (!doc && (!published.revision || !isPluginStateAuthoritative(c))) {
    sessions.set(c.req.raw, null)
    setStateHeader(c, 'miss')
    return null
  }
  const session = new PluginStateSession(c, store, appId, doc ?? { f: PLUGIN_STATE_FORMAT, app_id: appId, built_at: 0, exists: false })
  sessions.set(c.req.raw, session)
  markPluginStateServed(c)
  return session
}

/** The session decided for this request (null: database path or not decided yet). */
export function getPluginStateRequest(c: AnyContext) {
  return sessions.get(c.req.raw) ?? null
}

/** Drop the decision after a fallback: the rest of the request uses the database. */
export function abandonPluginStateRequest(c: AnyContext) {
  sessions.set(c.req.raw, null)
  unmarkPluginStateServed(c)
  setStateHeader(c, 'fallback')
}

function setStateHeader(c: AnyContext, value: string) {
  try {
    c.header(PLUGIN_STATE_HEADER, value)
  }
  catch {
    // Immutable response: observability only.
  }
}

export function markPluginStateResponse(response: Response, value = 'kv') {
  try {
    response.headers.set(PLUGIN_STATE_HEADER, value)
  }
  catch {
    // Immutable response headers: observability only.
  }
}

/**
 * Drizzle client for code served from the session: its queries are answered
 * by the session (pluginStateRegistry.ts). The connection behind it only
 * opens if some query escaped the state: strict mode fails it, otherwise it
 * reads the replica and logs the escape.
 */
export function createPluginStateDatabase(c: AnyContext, session: PluginStateSession) {
  const strict = isPluginStateStrict(c)
  const lazy = createLazyPgClient(c, true, {
    forbidConnect: strict ? 'plugin state strict mode: a query escaped the KV state' : undefined,
    onConnect: () => cloudlog({ requestId: c.get('requestId'), message: 'plugin state query escaped to the database', app_id: session.appId }),
  })
  const drizzle = getDrizzleClient(lazy.client, { logger: false })
  bindPluginStateQueries(drizzle, session)
  return { drizzle, lazy }
}

export class PluginStateSession implements PluginStateQueries {
  private readonly overrides = new Map<string, Promise<number | null>>()
  private readonly versions = new Map<string, Promise<PluginStateVersionDoc | null>>()
  private readonly manifests = new Map<string, Promise<PluginStateManifestDoc | null>>()

  constructor(
    private readonly c: AnyContext,
    private readonly store: KVNamespace,
    readonly appId: string,
    readonly doc: PluginStateAppDoc,
  ) {}

  get exists() {
    return this.doc.exists
  }

  private now() {
    return Date.now()
  }

  /** Channel of the device's override (channel_devices), null without one. */
  overrideChannelId(deviceId: string): Promise<number | null> {
    if (!this.doc.exists)
      return Promise.resolve(null)
    const inline = this.doc.overrides
    if (inline)
      return Promise.resolve(Object.hasOwn(inline, deviceId) ? inline[deviceId] : null)
    let pending = this.overrides.get(deviceId)
    if (!pending) {
      pending = pluginStateDeviceKey(this.appId, deviceId)
        .then(kvKey => loadDoc<PluginStateDeviceDoc>(this.c, this.store, {
          cachePath: DEVICE_CACHE_PATH,
          params: { app_id: this.appId, device_id: deviceId },
          kvKey,
          tags: [pluginStateAppCacheTag(this.appId)],
          ttlSeconds: APP_CACHE_TTL_SECONDS,
          parse: parsePluginStateDevice,
        }))
        .then((value) => {
          if (value === null)
            throw new PluginStateMiss('device override not synced')
          const channelId = value.channel_id
          if (channelId !== null && !this.doc.channels?.some(row => row.channels.id === channelId))
            throw new PluginStateMiss('device override channel not synced')
          return channelId
        })
        .catch(() => { throw new PluginStateMiss('device override unavailable or invalid') })
      this.overrides.set(deviceId, pending)
    }
    return pending
  }

  private version(versionName: string): Promise<PluginStateVersionDoc | null> {
    if (!this.doc.exists)
      return Promise.resolve(null)
    let pending = this.versions.get(versionName)
    if (!pending) {
      pending = pluginStateVersionKey(this.appId, versionName).then(kvKey => loadDoc<PluginStateVersionDoc>(this.c, this.store, {
        cachePath: VERSION_CACHE_PATH,
        params: { app_id: this.appId, name: versionName },
        kvKey,
        tags: [pluginStateAppCacheTag(this.appId)],
        ttlSeconds: VERSION_CACHE_TTL_SECONDS,
        parse: parsePluginStateVersion,
      })).then((doc) => {
        if (!doc)
          throw new PluginStateMiss('bundle name not synced')
        return doc
      })
      this.versions.set(versionName, pending)
    }
    return pending
  }

  /** Missing manifests always fall back: backfill only covers channel-referenced bundles. */
  manifest(versionId: number | string): Promise<PluginStateManifestDoc | null> {
    const id = String(versionId)
    let pending = this.manifests.get(id)
    if (!pending) {
      pending = loadDoc<PluginStateManifestDoc | PluginStateManifestFallbackDoc>(this.c, this.store, {
        cachePath: MANIFEST_CACHE_PATH,
        params: { app_id: this.appId, version_id: id },
        kvKey: pluginStateManifestKey(id),
        tags: [pluginStateAppCacheTag(this.appId)],
        ttlSeconds: MANIFEST_CACHE_TTL_SECONDS,
        reuseParsed: true,
        parse: parsePluginStateManifestStorage,
      }).then((doc) => {
        if (doc && String(doc.version_id) !== id)
          throw new PluginStateMiss('manifest identity mismatch')
        if (doc && doc.app_id !== this.appId)
          return null
        if (!doc)
          throw new PluginStateMiss(`manifest ${id}`)
        if ('fallback' in doc)
          throw new PluginStateMiss(`manifest exceeds snapshot limit: ${doc.reason}`)
        return doc
      })
      this.manifests.set(id, pending)
    }
    return pending
  }

  /** Version lookup of manifest size requests (null: no such bundle). */
  versionByName(versionName: string) {
    return this.version(versionName)
  }

  private async withManifest<T extends { version: Record<string, unknown> }>(row: T | undefined, includeManifest: boolean) {
    if (!row || !includeManifest)
      return row
    const versionId = row.version.id
    const manifestEntries = versionId === null || versionId === undefined ? [] : evalManifestEntries(await this.manifest(versionId as string | number))
    return { ...row, manifestEntries }
  }

  async appOwner(actions: Parameters<PluginStateQueries['appOwner']>[0], includeTrialAt: boolean) {
    return evalAppOwner(this.doc, actions, includeTrialAt, this.now())
  }

  async appById(actions: Parameters<PluginStateQueries['appById']>[0]) {
    return evalAppById(this.doc, actions, this.now())
  }

  async blockProviderInfraRequests() {
    return evalBlockProviderInfraRequests(this.doc)
  }

  async defaultChannel(platform: string, defaultChannel: string | null | undefined, includeManifest: boolean, includeMetadata: boolean) {
    return this.withManifest(evalDefaultChannel(this.doc, platform, defaultChannel, includeMetadata), includeManifest)
  }

  async defaultChannelRollout(platform: string, defaultChannel: string | null | undefined, includeMetadata: boolean) {
    return evalDefaultChannelRollout(this.doc, platform, defaultChannel, includeMetadata)
  }

  async channelById(channelId: number, includeManifest: boolean, includeMetadata: boolean) {
    return this.withManifest(evalChannelById(this.doc, channelId, includeMetadata), includeManifest)
  }

  async channelByIdRollout(channelId: number, includeMetadata: boolean) {
    return evalChannelByIdRollout(this.doc, channelId, includeMetadata)
  }

  async channelDevice(deviceId: string, includeManifest: boolean, includeMetadata: boolean) {
    const channelId = await this.overrideChannelId(deviceId)
    return this.withManifest(evalChannelDevice(this.doc, this.appId, deviceId, channelId, includeMetadata), includeManifest)
  }

  async channelDeviceRollout(deviceId: string, includeMetadata: boolean) {
    return evalChannelDeviceRollout(this.doc, await this.overrideChannelId(deviceId), includeMetadata)
  }

  async channelDeviceOverride(deviceId: string) {
    return evalChannelDeviceOverride(this.doc, this.appId, deviceId, await this.overrideChannelId(deviceId))
  }

  async channelLookup(filter: { name: string } | { id: number }) {
    return evalChannelLookup(this.doc, filter)
  }

  async mainChannels() {
    return evalMainChannels(this.doc)
  }

  async channels(condition: { defaultChannel?: string } | { public: boolean }) {
    return evalChannels(this.doc, condition)
  }

  async compatibleChannels(platform: string, isEmulator: boolean, isProd: boolean) {
    return evalCompatibleChannels(this.doc, platform, isEmulator, isProd)
  }

  async effectiveChannelById(channelId: number, platform: string) {
    return evalEffectiveChannel(this.doc, { by: 'id', id: channelId, platform })
  }

  async effectiveOverrideChannel(deviceId: string) {
    const channelId = await this.overrideChannelId(deviceId)
    return channelId === null ? undefined : evalEffectiveChannel(this.doc, { by: 'override', id: channelId })
  }

  async effectiveChannelByName(name: string | null, platform: string) {
    return name === null
      ? evalEffectiveChannel(this.doc, { by: 'public', platform })
      : evalEffectiveChannel(this.doc, { by: 'name', name, platform })
  }

  async appVersion(versionName: string, allowedDeleted: boolean | undefined) {
    return evalAppVersion(await this.version(versionName), allowedDeleted)
  }

  async manifestEntries(versionId: number | string) {
    return evalManifestEntries(await this.manifest(versionId))
  }
}

/**
 * Cache layout of the documents above. pluginStatePrewarm.ts writes the same
 * entries ahead of device requests, so both must agree on paths and TTLs.
 */
export const PLUGIN_STATE_CACHE = {
  app: { path: APP_CACHE_PATH, ttlSeconds: APP_CACHE_TTL_SECONDS },
  version: { path: VERSION_CACHE_PATH, ttlSeconds: VERSION_CACHE_TTL_SECONDS },
  manifest: { path: MANIFEST_CACHE_PATH, ttlSeconds: MANIFEST_CACHE_TTL_SECONDS },
  revisionHeader: REVISION_HEADER,
} as const
