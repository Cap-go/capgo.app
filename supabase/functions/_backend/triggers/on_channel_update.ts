import type { Context } from 'hono'
import type { NativePackage } from '../utils/bundle_compatibility.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import type {
  CompatibilityBundle,
  CompatibilityEventInsert,
  CompatibilityPlatform,
  CurrentDefaultForPlatform,
  PreviousDefault,
  UnresolvedCompatibilityEvent,
} from './compatibility_events.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, simpleError, triggerValidator } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { retryWithBackoff } from '../utils/retry.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import {
  COMPATIBILITY_PLATFORMS,
  decideAutoResolves,
  decideCompatibilityEvents,
} from './compatibility_events.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const UPDATE_RETRY_ATTEMPTS = 3
const UPDATE_RETRY_DELAY_MS = 300
const COMPATIBILITY_DEDUP_CONFLICT = 'app_id,channel_id,platform,current_version_id,previous_version_id,change_occurred_at'
// Upper bound on unresolved events scanned per auto-resolve pass: bounds the
// in-memory result set and the per-row UPDATE blast radius for busy apps. Far
// above any realistic count of distinct unresolved (version × platform) events;
// anything beyond is revisited on the next channel update.
const COMPATIBILITY_AUTO_RESOLVE_SCAN_LIMIT = 200
type ChannelRow = Database['public']['Tables']['channels']['Row']
type ChannelPlatformScope = 'ios' | 'android' | 'electron'

async function updateChannelsWithRetry(
  c: Context<MiddlewareKeyVariables>,
  operation: () => Promise<{ error: unknown }>,
  context: Record<string, unknown>,
) {
  const { result, lastError } = await retryWithBackoff(operation, {
    attempts: UPDATE_RETRY_ATTEMPTS,
    baseDelayMs: UPDATE_RETRY_DELAY_MS,
    shouldRetry: result => Boolean(result?.error),
  })
  if (result?.error || lastError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'on_channel_update failed after retries',
      error: result?.error ?? lastError,
      ...context,
    })
  }
}

async function getCurrentChannel(
  c: Context<MiddlewareKeyVariables>,
  channelId: number,
): Promise<Pick<ChannelRow, 'id' | 'app_id' | 'public' | 'ios' | 'android' | 'electron' | 'updated_at' | 'created_at'> | null> {
  const { data, error } = await supabaseAdmin(c)
    .from('channels')
    .select('id, app_id, public, ios, android, electron, updated_at, created_at')
    .eq('id', channelId)
    .maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to reload current channel state',
      error,
      channelId,
    })
    return null
  }

  return data
}

async function getCurrentPublicWinner(
  c: Context<MiddlewareKeyVariables>,
  record: Pick<ChannelRow, 'id' | 'app_id'>,
  scope: ChannelPlatformScope,
) {
  const currentRecord = await getCurrentChannel(c, record.id)
  if (!currentRecord?.public || !currentRecord[scope])
    return null

  const { data: winner, error } = await supabaseAdmin(c)
    .from('channels')
    .select('id')
    .eq('app_id', currentRecord.app_id)
    .eq('public', true)
    .eq(scope, true)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve current public channel winner',
      error,
      app_id: currentRecord.app_id,
      channelId: currentRecord.id,
      scope,
    })
    return null
  }

  return winner?.id === currentRecord.id ? currentRecord : null
}

/**
 * Load a bundle's compatibility metadata (`native_packages` + name) by version
 * id. Returns null when the id is missing or the row cannot be loaded; the
 * decision layer treats a null/empty bundle as an exclusion. We do NOT filter on
 * `deleted`: a soft-deleted baseline is still a valid installed-on-device
 * baseline as long as its metadata survives.
 */
async function loadCompatibilityBundle(
  c: Context<MiddlewareKeyVariables>,
  versionId: number | null | undefined,
): Promise<CompatibilityBundle | null> {
  if (versionId == null)
    return null

  const { data, error } = await supabaseAdmin(c)
    .from('app_versions')
    .select('id, name, native_packages')
    .eq('id', versionId)
    .maybeSingle()

  if (error || !data) {
    if (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to load bundle for compatibility event',
        error,
        versionId,
      })
    }
    return null
  }

  return {
    id: data.id,
    name: data.name,
    nativePackages: sanitizeNativePackages(data.native_packages),
  }
}

/**
 * Keep only entries that satisfy the CLI's `nativePackageSchema` shape — a
 * non-empty string `name` AND `version`. Malformed entries are dropped rather
 * than fed into `comparePackages`. When nothing usable survives we return null so
 * the decision layer treats the bundle as "cannot compute" (an exclusion) instead
 * of comparing against garbage.
 */
function sanitizeNativePackages(raw: unknown): NativePackage[] | null {
  if (!Array.isArray(raw))
    return null

  const usable = raw.filter((pkg): pkg is NativePackage =>
    Boolean(pkg)
    && typeof (pkg as NativePackage).name === 'string'
    && (pkg as NativePackage).name.length > 0
    && typeof (pkg as NativePackage).version === 'string'
    && (pkg as NativePackage).version.length > 0,
  )

  return usable.length > 0 ? usable : null
}

/**
 * Find the channel this update is about to demote for a platform — a different
 * channel that is still public for that platform right now — and return its id +
 * version. Must be called BEFORE the demotion update runs. The decision layer
 * only consumes this as the Case A baseline when the record NEWLY became the
 * public default for the platform (a real switch); on a non-switch edit the value
 * is ignored, so the prior `updated_at`-ordered baseline can no longer misfire.
 * The ordering here is only a tiebreaker; in practice a single other channel is
 * public per platform.
 */
async function getPreviousDefaultChannel(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  scope: ChannelPlatformScope,
  excludeChannelId: number,
): Promise<{ id: number, version: number | null } | null> {
  const { data, error } = await supabaseAdmin(c)
    .from('channels')
    .select('id, version')
    .eq('app_id', appId)
    .eq('public', true)
    .eq(scope, true)
    .neq('id', excludeChannelId)
    .order('updated_at', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve previous default channel for compatibility event',
      error,
      app_id: appId,
      scope,
    })
    return null
  }

  return data ?? null
}

/**
 * Compute and persist `compatibility_events` for one channel update. Fully
 * guarded: any failure here is logged and swallowed so it can never break the
 * channel winner reconciliation that already ran. `previousDefaultChannelByPlatform`
 * carries the Case A baseline channel captured before demotion.
 */
async function persistCompatibilityEvents(
  c: Context<MiddlewareKeyVariables>,
  record: ChannelRow,
  oldRecord: ChannelRow | undefined,
  previousDefaultChannelByPlatform: Partial<Record<CompatibilityPlatform, { id: number, version: number | null } | null>>,
): Promise<void> {
  try {
    // The new default's current bundle (candidate shipped OTA).
    const currentBundle = await loadCompatibilityBundle(c, record.version)

    // Resolve a previous-default candidate per platform the channel is default on.
    // Switch-aware: a platform only contributes when the record is the CURRENT
    // public default for it, and we distinguish a same-channel version bump
    // (Case B) from a genuine default switch (Case A). A non-switch edit on an
    // already-public winner (name/flag toggle, or no version delta) emits nothing.
    const previousDefaults: PreviousDefault[] = []
    for (const platform of COMPATIBILITY_PLATFORMS) {
      const recordIsDefault = Boolean(record.public && record[platform])
      if (!recordIsDefault)
        continue

      const oldWasDefault = Boolean(oldRecord && oldRecord.public && oldRecord[platform])

      if (oldWasDefault) {
        // Case B — same-channel version change. Only fires on an actual version
        // delta; an identical version (pure name/flag edit) yields no event.
        if (oldRecord?.version != null && oldRecord.version !== record.version) {
          previousDefaults.push({
            platform,
            source: 'default_channel_version_changed',
            bundle: await loadCompatibilityBundle(c, oldRecord.version),
          })
        }
      }
      else {
        // Case A — default-channel switch: record NEWLY became the public default
        // for this platform. The baseline is the channel this update demotes,
        // captured before the demotion update ran.
        const demotedChannel = previousDefaultChannelByPlatform[platform]
        if (demotedChannel) {
          previousDefaults.push({
            platform,
            source: 'default_channel_changed',
            bundle: await loadCompatibilityBundle(c, demotedChannel.version),
          })
        }
      }
    }

    // Unresolved events for this channel, so the decision layer can recognize a
    // revert to a known baseline and skip raising a mirror event for it.
    const { data: channelUnresolved, error: channelUnresolvedError } = await supabaseAdmin(c)
      .from('compatibility_events')
      .select('id, platform, channel_id, previous_version_id, previous_version_name, current_version_id')
      .eq('app_id', record.app_id)
      .eq('channel_id', record.id)
      .is('resolved_at', null)
      .order('id', { ascending: false })
      .limit(COMPATIBILITY_AUTO_RESOLVE_SCAN_LIMIT)
    if (channelUnresolvedError) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to load unresolved compatibility events for revert detection',
        error: channelUnresolvedError,
        app_id: record.app_id,
        channel_id: record.id,
      })
    }

    const events = decideCompatibilityEvents({
      newChannel: record,
      currentBundle,
      previousDefaults,
      changeOccurredAt: record.updated_at ?? new Date().toISOString(),
      unresolvedEvents: (channelUnresolved ?? []) as UnresolvedCompatibilityEvent[],
    })

    for (const event of events) {
      await updateChannelsWithRetry(
        c,
        async () => await supabaseAdmin(c)
          .from('compatibility_events')
          .upsert(event as CompatibilityEventInsert, { onConflict: COMPATIBILITY_DEDUP_CONFLICT }),
        { app_id: event.app_id, channel_id: event.channel_id, platform: event.platform, op: 'compatibility_event_upsert' },
      )
    }

    await autoResolveCompatibilityEvents(c, record, currentBundle, previousDefaults)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to persist compatibility events',
      error,
      app_id: record.app_id,
      channel_id: record.id,
    })
  }
}

/**
 * Auto-resolve unresolved events for this app whose platform's current default is
 * now OTA-compatible with the event's previous (baseline) bundle. Writes a
 * generated note and `resolution_kind = 'auto_compatible'` (`resolved_by = null`).
 */
async function autoResolveCompatibilityEvents(
  c: Context<MiddlewareKeyVariables>,
  record: ChannelRow,
  currentBundle: CompatibilityBundle | null,
  previousDefaults: readonly PreviousDefault[],
): Promise<void> {
  // Compute the current default bundle per platform FIRST. If the record is not a
  // current public default on any platform, nothing here can auto-resolve, so we
  // skip the unresolved-events SELECT entirely.
  const currentDefaultByPlatform: CurrentDefaultForPlatform[] = []
  for (const platform of COMPATIBILITY_PLATFORMS) {
    if (record.public && record[platform])
      currentDefaultByPlatform.push({ platform, bundle: currentBundle })
  }
  if (currentDefaultByPlatform.length === 0)
    return

  const { data: unresolved, error } = await supabaseAdmin(c)
    .from('compatibility_events')
    .select('id, platform, channel_id, previous_version_id, previous_version_name, current_version_id')
    .eq('app_id', record.app_id)
    .is('resolved_at', null)
    .order('id', { ascending: false })
    .limit(COMPATIBILITY_AUTO_RESOLVE_SCAN_LIMIT)

  if (error || !unresolved || unresolved.length === 0) {
    if (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to load unresolved compatibility events for auto-resolve',
        error,
        app_id: record.app_id,
      })
    }
    return
  }

  // Resolve baseline bundles referenced by the unresolved events.
  const bundlesById = new Map<number, CompatibilityBundle>()
  if (currentBundle)
    bundlesById.set(currentBundle.id, currentBundle)
  for (const previous of previousDefaults) {
    if (previous.bundle)
      bundlesById.set(previous.bundle.id, previous.bundle)
  }
  const events = unresolved as UnresolvedCompatibilityEvent[]
  for (const event of events) {
    if (event.previous_version_id != null && !bundlesById.has(event.previous_version_id)) {
      const loaded = await loadCompatibilityBundle(c, event.previous_version_id)
      if (loaded)
        bundlesById.set(loaded.id, loaded)
    }
  }

  const resolves = decideAutoResolves(events, currentDefaultByPlatform, bundlesById)

  for (const resolve of resolves) {
    await updateChannelsWithRetry(
      c,
      async () => await supabaseAdmin(c)
        .from('compatibility_events')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: null,
          resolution_kind: 'auto_compatible',
          resolution_note: resolve.note,
        })
        .eq('id', resolve.id)
        .is('resolved_at', null),
      { event_id: resolve.id, op: 'compatibility_event_auto_resolve' },
    )
  }
}

app.post('/', middlewareAPISecret, triggerValidator('channels', 'UPDATE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['channels']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No id' })
    throw simpleError('no_id', 'No id', { record })
  }
  if (!record.app_id) {
    cloudlog({ requestId: c.get('requestId'), message: 'No app id included the request' })
    throw simpleError('no_app_id', 'No app id included the request', { record })
  }

  const oldRecord = c.get('oldRecord') as ChannelRow | undefined
  // Capture the demoted prior default per platform (Case A baseline) BEFORE the
  // demotion update runs. After demotion it would no longer be `public = true`.
  const previousDefaultChannelByPlatform: Partial<Record<CompatibilityPlatform, { id: number, version: number | null } | null>> = {}

  if (record.public && record.ios) {
    const currentWinner = await getCurrentPublicWinner(c, record, 'ios')
    if (currentWinner) {
      previousDefaultChannelByPlatform.ios = await getPreviousDefaultChannel(c, currentWinner.app_id, 'ios', record.id)
      await updateChannelsWithRetry(
        c,
        async () => await supabaseAdmin(c)
          .from('channels')
          .update({ public: false })
          .eq('app_id', currentWinner.app_id)
          .eq('ios', true)
          .neq('id', record.id),
        { app_id: currentWinner.app_id, record_id: record.id, scope: 'ios' },
      )
    }
  }

  if (record.public && record.android) {
    const currentWinner = await getCurrentPublicWinner(c, record, 'android')
    if (currentWinner) {
      previousDefaultChannelByPlatform.android = await getPreviousDefaultChannel(c, currentWinner.app_id, 'android', record.id)
      await updateChannelsWithRetry(
        c,
        async () => await supabaseAdmin(c)
          .from('channels')
          .update({ public: false })
          .eq('app_id', currentWinner.app_id)
          .eq('android', true)
          .neq('id', record.id),
        { app_id: currentWinner.app_id, record_id: record.id, scope: 'android' },
      )
    }
  }

  if (record.public && record.electron) {
    const currentWinner = await getCurrentPublicWinner(c, record, 'electron')
    if (currentWinner) {
      previousDefaultChannelByPlatform.electron = await getPreviousDefaultChannel(c, currentWinner.app_id, 'electron', record.id)
      await updateChannelsWithRetry(
        c,
        async () => await supabaseAdmin(c)
          .from('channels')
          .update({ public: false })
          .eq('app_id', currentWinner.app_id)
          .eq('electron', true)
          .neq('id', record.id),
        { app_id: currentWinner.app_id, record_id: record.id, scope: 'electron' },
      )
    }
  }

  // Compute + persist compatibility events. Fully guarded so it can never break
  // the channel winner reconciliation above.
  await persistCompatibilityEvents(c, record, oldRecord, previousDefaultChannelByPlatform)

  return c.json(BRES)
})
