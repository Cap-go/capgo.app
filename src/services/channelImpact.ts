import { defaultApiHost, useConsole } from '~/services/console'

// Mirrors supabase/functions/_backend/private/channel_impact.ts.
export type ChannelImpactPlatform = 'ios' | 'android' | 'electron' | 'unknown'
export type ChannelImpactStrategy = 'major' | 'minor' | 'patch' | 'version_number' | 'none'
export type ChannelImpactOutcome
  = | 'receive'
    | 'receive_below_native'
    | 'revert_to_builtin'
    | 'already_on_target'
    | 'blocked_major'
    | 'blocked_minor'
    | 'blocked_patch'
    | 'blocked_metadata'
    | 'blocked_misconfigured'
    | 'blocked_private_channel'
    | 'blocked_under_native'
    | 'blocked_platform'
    | 'blocked_build_type'
    | 'plugin_too_old'
    | 'unknown_native'

export type ChannelImpactTargetRequest
  = | { kind: 'bundle', version_id: number }
    | { kind: 'builtin' }
    | { kind: 'previous' }

export interface ChannelImpactBundleRef {
  id: number
  name: string
}

export interface ChannelImpactSample {
  device_id: string
  platform: ChannelImpactPlatform
  version_build: string
  version_name: string
  plugin_version: string
  is_prod: boolean | null
  is_emulator: boolean | null
  last_seen: string | null
  outcome: ChannelImpactOutcome
  device_count: number
}

export interface ChannelImpactNativeVersion {
  platform: ChannelImpactPlatform
  version_build: string
  device_count: number
  receive: number
  outcome: ChannelImpactOutcome
}

export interface ChannelImpactResult {
  target: { kind: 'bundle' | 'builtin', id: number | null, name: string }
  total_devices: number
  receive: number
  rollout_receive: number | null
  outcomes: Record<ChannelImpactOutcome, number>
  requirement: { strategy: 'major' | 'minor' | 'patch' | 'metadata', native: string } | null
  native_versions: ChannelImpactNativeVersion[]
  samples: ChannelImpactSample[]
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
    current_bundle: ChannelImpactBundleRef | null
    rollout: { bundle: ChannelImpactBundleRef | null, enabled: boolean, percentage_bps: number, paused: boolean }
  }
  previous_bundle: ChannelImpactBundleRef | null
  window_days: number
  total_devices: number
  truncated: boolean
  samples_included: boolean
  impacts: ChannelImpactResult[]
  generated_at: string
}

export interface ChannelImpactRequest {
  appId: string
  channelId: number
  targets: ChannelImpactTargetRequest[]
  mode?: 'stable' | 'rollout'
  rolloutPercentageBps?: number
}

export const STRATEGY_BLOCKED_OUTCOMES: ReadonlySet<ChannelImpactOutcome> = new Set(['blocked_major', 'blocked_minor', 'blocked_patch', 'blocked_metadata'])

// The server already caches the device scan; this only makes reopening the
// same dialog instant and collapses duplicate in-flight requests.
const CLIENT_CACHE_MS = 15_000
const cache = new Map<string, { at: number, promise: Promise<ChannelImpactResponse> }>()

function cacheKey(request: ChannelImpactRequest) {
  return JSON.stringify([request.appId, request.channelId, request.targets, request.mode ?? 'stable', request.rolloutPercentageBps ?? null])
}

export class ChannelImpactError extends Error {
  constructor(public status: number) {
    super(`channel impact request failed (${status})`)
    this.name = 'ChannelImpactError'
  }
}

async function requestChannelImpact(request: ChannelImpactRequest): Promise<ChannelImpactResponse> {
  const { data } = await useConsole().auth.getSession()
  const token = data.session?.access_token
  if (!token)
    throw new ChannelImpactError(401)
  const response = await fetch(`${defaultApiHost}/private/channel_impact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      app_id: request.appId,
      channel_id: request.channelId,
      targets: request.targets,
      mode: request.mode,
      rollout_percentage_bps: request.rolloutPercentageBps,
    }),
  })
  if (!response.ok)
    throw new ChannelImpactError(response.status)
  return await response.json() as ChannelImpactResponse
}

export function fetchChannelImpact(request: ChannelImpactRequest): Promise<ChannelImpactResponse> {
  const key = cacheKey(request)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CLIENT_CACHE_MS)
    return hit.promise
  const promise = requestChannelImpact(request)
  cache.set(key, { at: now, promise })
  // A failed request must not be served from the cache.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise)
      cache.delete(key)
  })
  return promise
}

/** Drop cached previews of a channel after it changed (bundle set, reverted, rolled out). */
export function invalidateChannelImpact(channelId?: number) {
  if (channelId == null) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    const [, cachedChannelId] = JSON.parse(key) as [string, number]
    if (cachedChannelId === channelId)
      cache.delete(key)
  }
}

export function formatImpactPercent(part: number, total: number) {
  if (!total)
    return '0%'
  const value = (part / total) * 100
  const digits = value > 0 && value < 1 ? 1 : 0
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })}%`
}
