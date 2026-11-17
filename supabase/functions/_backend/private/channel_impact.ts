import type { Context } from 'hono'
import type { ChannelImpactChannelConfig, ChannelImpactStrategy, ChannelImpactSummary, ChannelImpactTarget } from '../utils/channel_impact.ts'
import type { ChannelDevicePopulation } from '../utils/channel_impact_population.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { CacheHelper } from '../utils/cache.ts'
import { CHANNEL_IMPACT_WINDOW_DAYS, estimateRolloutReceive, summarizeChannelImpact } from '../utils/channel_impact.ts'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr, serializeError } from '../utils/logging.ts'
import { authPrincipal, queryJsonOne, withRlsContext } from '../utils/pg_rls.ts'
import { appIdSchema } from '../utils/privateAnalyticsValidation.ts'
import { checkPermission } from '../utils/rbac.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { readChannelDevicePopulation } from '../utils/stats.ts'

// "Who gets what if I change this channel?" for the console confirm dialogs
// (set a bundle, start a progressive rollout, roll back, revert to the store
// bundle). Channel and bundle rows are read fresh as the caller (one RLS
// transaction); the device population behind the counts is a full device_info
// scan, so it sits behind a short colo cache keyed per app + channel. Several
// targets share one scan, so the revert dialog asks for both choices at once.
const POPULATION_CACHE_TTL_SECONDS = 120
const POPULATION_CACHE_PATH = '/.channel-impact-population'
const MAX_TARGETS = 3

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundle'), version_id: z.number().int().positive() }),
  z.object({ kind: z.literal('builtin') }),
  z.object({ kind: z.literal('previous') }),
])

const bodySchema = z.object({
  app_id: appIdSchema,
  channel_id: z.number().int().positive(),
  targets: z.array(targetSchema).min(1).max(MAX_TARGETS),
  mode: z.enum(['stable', 'rollout']).optional(),
  rollout_percentage_bps: z.number().int().min(0).max(10000).optional(),
})

type ChannelImpactRequest = z.infer<typeof bodySchema>
type RequestedTarget = ChannelImpactRequest['targets'][number]

interface BundleRef {
  id: number
  name: string
  min_update_version?: string | null
  key_id?: string | null
}

interface ChannelRow {
  id: number
  name: string
  public: boolean
  allow_device_self_set: boolean
  paused_at: string | null
  disable_auto_update: ChannelImpactStrategy
  disable_auto_update_under_native: boolean
  ios: boolean
  android: boolean
  electron: boolean
  allow_prod: boolean
  allow_dev: boolean
  allow_device: boolean
  allow_emulator: boolean
  rollout_enabled: boolean | null
  rollout_percentage_bps: number | null
  rollout_paused_at: string | null
  current_bundle: BundleRef | null
  rollout_bundle: BundleRef | null
  previous_bundle: BundleRef | null
  bundles: Array<BundleRef & { deleted: boolean }> | null
}

export interface ChannelImpactResult extends ChannelImpactSummary {
  target: { kind: 'bundle' | 'builtin', id: number | null, name: string }
  /** Expected devices in the first wave when the target is set as a progressive rollout. */
  rollout_receive: number | null
}

export interface ChannelImpactResponse {
  app_id: string
  channel: {
    id: number
    name: string
    public: boolean
    paused: boolean
    strategy: ChannelImpactStrategy
    under_native_guard: boolean
    current_bundle: BundleRef | null
    rollout: { bundle: BundleRef | null, enabled: boolean, percentage_bps: number, paused: boolean }
  }
  /** Bundle the channel served before the current one (rollback choice), when it still exists. */
  previous_bundle: BundleRef | null
  window_days: number
  total_devices: number
  truncated: boolean
  samples_included: boolean
  impacts: ChannelImpactResult[]
  generated_at: string
}

const INTERNAL_VERSION_NAMES = new Set(['builtin', 'unknown'])

function bundleRef(value: BundleRef | null | undefined): BundleRef | null {
  if (!value || INTERNAL_VERSION_NAMES.has(value.name))
    return null
  return { id: Number(value.id), name: value.name }
}

function cacheBucket(ttlSeconds: number, nowMs = Date.now()) {
  return String(Math.floor(nowMs / (ttlSeconds * 1000)))
}

async function readChannelRow(c: Context<MiddlewareKeyVariables>, body: ChannelImpactRequest): Promise<ChannelRow | null> {
  const bundleIds = body.targets.flatMap(target => target.kind === 'bundle' ? [target.version_id] : [])
  // One statement in one RLS transaction: always fresh, and the caller only sees
  // channels, bundles and deploy history their role allows.
  return await withRlsContext(c, authPrincipal(c), client => queryJsonOne<ChannelRow>(
    client,
    `SELECT ch.id, ch.name, ch.public, ch.allow_device_self_set, ch.paused_at,
      ch.disable_auto_update, ch.disable_auto_update_under_native,
      ch.ios, ch.android, ch.electron,
      ch.allow_prod, ch.allow_dev, ch.allow_device, ch.allow_emulator,
      ch.rollout_enabled, ch.rollout_percentage_bps, ch.rollout_paused_at,
      (SELECT pg_catalog.json_build_object('id', av.id, 'name', av.name) FROM public.app_versions av WHERE av.id = ch.version) AS current_bundle,
      (SELECT pg_catalog.json_build_object('id', av.id, 'name', av.name) FROM public.app_versions av WHERE av.id = ch.rollout_version) AS rollout_bundle,
      (SELECT pg_catalog.json_build_object('id', av.id, 'name', av.name, 'min_update_version', av.min_update_version, 'key_id', av.key_id)
        FROM public.deploy_history dh
        JOIN public.app_versions av ON av.id = dh.version_id
        WHERE dh.channel_id = ch.id
          AND dh.app_id = ch.app_id
          AND dh.version_id IS DISTINCT FROM ch.version
          AND av.deleted = false
          AND av.name NOT IN ('builtin', 'unknown')
        ORDER BY dh.deployed_at DESC NULLS LAST, dh.id DESC
        LIMIT 1) AS previous_bundle,
      (SELECT pg_catalog.json_agg(pg_catalog.json_build_object('id', av.id, 'name', av.name, 'min_update_version', av.min_update_version, 'key_id', av.key_id, 'deleted', av.deleted))
        FROM public.app_versions av
        WHERE av.app_id = ch.app_id AND av.id = ANY($3::bigint[])) AS bundles
    FROM public.channels ch
    WHERE ch.id = $1 AND ch.app_id = $2`,
    [body.channel_id, body.app_id, bundleIds],
  ))
}

async function readPopulation(c: Context<MiddlewareKeyVariables>, appId: string, channel: { id: number, name: string }): Promise<ChannelDevicePopulation> {
  const cache = new CacheHelper(c)
  const cacheKey = cache.buildRequest(POPULATION_CACHE_PATH, {
    appId,
    channelId: String(channel.id),
    channelName: channel.name,
    bucket: cacheBucket(POPULATION_CACHE_TTL_SECONDS),
  })
  const cached = await cache.matchJson<ChannelDevicePopulation>(cacheKey)
  if (cached)
    return cached
  const population = await readChannelDevicePopulation(c, appId, channel)
  await cache.putJson(cacheKey, population, POPULATION_CACHE_TTL_SECONDS)
  return population
}

function resolveTarget(row: ChannelRow, requested: RequestedTarget): ChannelImpactTarget & { id: number | null } {
  if (requested.kind === 'builtin')
    return { kind: 'builtin', id: null }
  if (requested.kind === 'previous') {
    const previous = row.previous_bundle
    if (!previous)
      throw simpleError('no_previous_bundle', 'This channel has no previous bundle to roll back to')
    return { kind: 'bundle', id: Number(previous.id), name: previous.name, min_update_version: previous.min_update_version ?? null, key_id: previous.key_id ?? null }
  }
  const bundle = (row.bundles ?? []).find(item => Number(item.id) === requested.version_id)
  if (!bundle || bundle.deleted)
    throw simpleError('cannot_find_version', 'Cannot find version', { version_id: requested.version_id })
  if (INTERNAL_VERSION_NAMES.has(bundle.name))
    return { kind: 'builtin', id: null }
  return { kind: 'bundle', id: Number(bundle.id), name: bundle.name, min_update_version: bundle.min_update_version ?? null, key_id: bundle.key_id ?? null }
}

function channelConfig(row: ChannelRow): ChannelImpactChannelConfig {
  return {
    disable_auto_update: row.disable_auto_update,
    disable_auto_update_under_native: !!row.disable_auto_update_under_native,
    ios: !!row.ios,
    android: !!row.android,
    electron: !!row.electron,
    allow_prod: !!row.allow_prod,
    allow_dev: !!row.allow_dev,
    allow_device: !!row.allow_device,
    allow_emulator: !!row.allow_emulator,
    assigned_devices_only: !row.public && !row.allow_device_self_set,
  }
}

export function buildChannelImpactResponse(
  appId: string,
  row: ChannelRow,
  population: ChannelDevicePopulation,
  targets: RequestedTarget[],
  options: { mode?: 'stable' | 'rollout', rolloutPercentageBps?: number, includeSamples: boolean, now?: Date },
): ChannelImpactResponse {
  const config = channelConfig(row)
  const rolloutBps = options.rolloutPercentageBps ?? row.rollout_percentage_bps ?? 0
  const impacts = targets.map((requested) => {
    const target = resolveTarget(row, requested)
    const summary = summarizeChannelImpact(population.groups, config, target)
    return {
      ...summary,
      // Setups past the cap are not evaluated; the response says so with `truncated`.
      samples: options.includeSamples ? summary.samples : [],
      target: { kind: target.kind, id: target.id, name: target.kind === 'builtin' ? 'builtin' : target.name },
      rollout_receive: options.mode === 'rollout' ? estimateRolloutReceive(summary.receive, rolloutBps) : null,
    } satisfies ChannelImpactResult
  })

  return {
    app_id: appId,
    channel: {
      id: Number(row.id),
      name: row.name,
      public: !!row.public,
      paused: !!row.paused_at,
      strategy: row.disable_auto_update,
      under_native_guard: !!row.disable_auto_update_under_native,
      current_bundle: bundleRef(row.current_bundle),
      rollout: {
        bundle: bundleRef(row.rollout_bundle),
        enabled: !!row.rollout_enabled,
        percentage_bps: row.rollout_percentage_bps ?? 0,
        paused: !!row.rollout_paused_at,
      },
    },
    previous_bundle: bundleRef(row.previous_bundle),
    window_days: CHANNEL_IMPACT_WINDOW_DAYS,
    total_devices: population.total_devices,
    truncated: population.truncated,
    samples_included: options.includeSamples,
    impacts,
    generated_at: (options.now ?? new Date()).toISOString(),
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const parsed = safeParseSchema(bodySchema, await parseBody<unknown>(c))
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body')
  const body = parsed.data

  const [canReadChannel, canReadDevices, row] = await Promise.all([
    checkPermission(c, 'channel.read', { appId: body.app_id, channelId: body.channel_id }),
    checkPermission(c, 'app.read_devices', { appId: body.app_id }),
    readChannelRow(c, body).catch((error: unknown) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'channel_impact channel read failed', error: serializeError(error) })
      return null
    }),
  ])
  if (!canReadChannel)
    throw quickError(403, 'channel_access_denied', 'You can\'t access this channel', { app_id: body.app_id, channel_id: body.channel_id })
  if (!row)
    throw quickError(404, 'channel_not_found', 'Channel not found', { app_id: body.app_id, channel_id: body.channel_id })

  try {
    const population = await readPopulation(c, body.app_id, { id: Number(row.id), name: row.name })
    return c.json(buildChannelImpactResponse(body.app_id, row, population, body.targets, {
      mode: body.mode,
      rolloutPercentageBps: body.rollout_percentage_bps,
      includeSamples: canReadDevices,
    }))
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error computing channel impact', error: serializeError(error) })
    throw simpleError('fetch_error', 'Failed to compute channel impact')
  }
})
