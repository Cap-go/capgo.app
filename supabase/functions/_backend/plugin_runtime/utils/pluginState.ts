import type { KVNamespace } from '@cloudflare/workers-types'
import type { Context } from 'hono'
import type { PluginStateAppDoc, PluginStateDeviceDoc, PluginStateManifestDoc, PluginStateManifestFallbackDoc, PluginStateVersionDoc } from './pluginStateFormat.ts'
import type { PluginStateQueries } from './pluginStateRegistry.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
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
import { bindPluginStateQueries, PluginStateMiss } from './pluginStateRegistry.ts'
import { readPublishedPluginState } from './pluginStateStore.ts'
import { isPluginStateStrict, markPluginStateServed, parsePluginStateShareBps, pluginStateBucket, unmarkPluginStateServed } from './pluginStateSwitch.ts'
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
 * Reads: isolate memory -> Cache API (per data center, free, purged by the
 * app's Cache-Tag after each sync) -> Workers KV. The app document is the
 * completion marker of an app: the sync writes every other key of the app
 * (bundle names, device overrides, served manifests) before it.
 *
 * Rollout: worker secret `PLUGIN_STATE_KV` (off | on | N% of devices), one
 * stable decision per device. A device whose app has no document yet uses
 * the database path, unless `PLUGIN_STATE_KV_AUTHORITATIVE=true` (set once
 * the backfill is complete): a missing document then means a missing app.
 * `PLUGIN_STATE_KV_STRICT=true` (tests) fails any database access of a
 * request served from the state.
 */

const APP_CACHE_PATH = '/.plugin-state-app-v2'
const DEVICE_CACHE_PATH = '/.plugin-state-device-v2'
const VERSION_CACHE_PATH = '/.plugin-state-version-v2'
const MANIFEST_CACHE_PATH = '/.plugin-state-manifest-v2'
/** A stale KV refill must not be amplified into hours of Cache API staleness. */
const APP_CACHE_TTL_SECONDS = 30
const VERSION_CACHE_TTL_SECONDS = 30
const MANIFEST_CACHE_TTL_SECONDS = 30
/** A missing key is cached shorter: its creation purges it anyway. */
const NEGATIVE_CACHE_TTL_SECONDS = 60
/** App documents can be large: allow more than the default 20ms Cache API read. */
const CACHE_MATCH_TIMEOUT_MS = 50
const CACHE_PUT_TIMEOUT_MS = 200
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

function isLocalEnv(c: AnyContext) {
  return getEnv(c, 'ENV_NAME').endsWith('-local')
}

export function isPluginStateAuthoritative(c: AnyContext) {
  return getEnv(c, 'PLUGIN_STATE_KV_AUTHORITATIVE').trim().toLowerCase() === 'true'
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
  if (!getStore(c))
    return false
  const forced = forcedMode(c)
  if (forced)
    return forced === 'kv'
  const bps = parsePluginStateShareBps(getEnv(c, 'PLUGIN_STATE_KV'))
  return bps >= 10_000 || (bps > 0 && Boolean(deviceId) && pluginStateBucket(appId, deviceId) < bps)
}

interface CachedDoc<T> {
  revision: string
  value: T | null
}

const memory = new Map<string, CachedDoc<unknown> & { estimatedBytes: number }>()
let memoryBytes = 0

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
 * One document: Cache API (reusing the parsed copy in isolate memory when
 * the entry is the same build), then KV. null: the key is not in KV.
 */
function loadDoc<T>(c: AnyContext, store: KVNamespace, options: DocLoadOptions<T>): Promise<T | null> {
  return withPluginStateDocument(c, options.kvKey, () => loadDocument(c, store, options))
}

async function loadDocument<T>(c: AnyContext, store: KVNamespace, options: DocLoadOptions<T>): Promise<T | null> {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(options.cachePath, options.params)
  const cached = await helper.matchResponse(request, { timeoutMs: CACHE_MATCH_TIMEOUT_MS })
  if (cached) {
    const revision = cached.headers.get(REVISION_HEADER)
    const remembered = options.reuseParsed ? memory.get(request.url) as CachedDoc<T> | undefined : undefined
    if (remembered && revision && remembered.revision === revision) {
      await cached.body?.cancel().catch(() => undefined)
      return remembered.value
    }
    try {
      const envelope: unknown = await cached.json()
      if (!envelope || typeof envelope !== 'object' || !('v' in envelope))
        throw new Error('Invalid cached plugin state envelope')
      const value = envelope.v === null ? null : options.parse(envelope.v)
      if (options.reuseParsed && revision)
        rememberDoc(request.url, { revision, value })
      return value
    }
    catch {
      // Unreadable entry: read KV again.
    }
  }

  let value: T | null
  let revision: string | null
  try {
    const published = await readPublishedPluginState(c, store, options.kvKey)
    value = published.value === null ? null : options.parse(published.value)
    revision = published.revision
  }
  catch {
    throw new PluginStateMiss('document unavailable or invalid')
  }
  if (options.reuseParsed && revision)
    rememberDoc(request.url, { revision, value })
  await backgroundTask(c, helper.putJson(request, { v: value }, value === null ? NEGATIVE_CACHE_TTL_SECONDS : options.ttlSeconds, {
    tags: options.tags,
    timeoutMs: CACHE_PUT_TIMEOUT_MS,
    headers: revision ? { [REVISION_HEADER]: revision } : undefined,
  }))
  return value
}

function loadAppDoc(c: AnyContext, store: KVNamespace, appId: string, kvKey: string) {
  return loadDoc<PluginStateAppDoc>(c, store, {
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
  let doc: PluginStateAppDoc | null
  try {
    doc = await loadAppDoc(c, store, appId, await pluginStateAppKey(appId))
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'plugin state read failed, using the database', app_id: appId, error })
    doc = null
    sessions.set(c.req.raw, null)
    setStateHeader(c, 'error')
    return null
  }
  if (doc && doc.app_id !== appId) {
    sessions.set(c.req.raw, null)
    setStateHeader(c, 'error')
    return null
  }
  if (!doc && !isPluginStateAuthoritative(c)) {
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
          return parsePluginStateDevice(value).channel_id
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
