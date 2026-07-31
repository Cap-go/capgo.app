import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'

const MAX_BPS = 10000
const DEFAULT_ROLLOUT_CACHE_TTL_SECONDS = 2592000

export type AutoPauseAction = 'pause' | 'rollback' | 'notify'

export interface RolloutDecisionCachePayload {
  selected: boolean
  percentage_bps: number
  rollout_id: string
  rollout_version: number
  created_at: string
  updated_at: string
}

export interface RolloutDecisionInput {
  appId: string
  channelId: number
  currentVersionName: string
  deviceId: string
  rolloutCacheTtlSeconds: number | null | undefined
  rolloutEnabled: boolean
  rolloutId: string
  rolloutPausedAt: Date | string | null
  rolloutPercentageBps: number | null | undefined
  rolloutVersionId: number
  rolloutVersionName: string
  cachePayload?: RolloutDecisionCachePayload | null
  now?: Date
  randomBps?: () => number
}

export interface RolloutDecisionResult {
  payload: RolloutDecisionCachePayload | null
  reason: 'already_on_rollout' | 'cached_selected' | 'cached_unselected' | 'disabled' | 'paused' | 'cache_miss' | 'delta_reroll' | 'percentage_decrease_reroll' | 'percentage_zero'
  selected: boolean
  shouldWriteCache: boolean
  ttlSeconds: number
}

export interface AutoPauseEvaluationInput {
  action: AutoPauseAction
  confidence: number
  cooldownMinutes: number
  enabled: boolean
  failureRateBps: number | null
  failures: number
  installs: number
  lastTriggeredAt?: Date | string | null
  minAttempts?: number | null
  minFailures?: number | null
  now?: Date
}

export interface AutoPauseEvaluationResult {
  action: AutoPauseAction
  attempts: number
  failureRateBps: number
  lowerBoundBps: number
  reason: 'disabled' | 'missing_threshold' | 'cooldown' | 'insufficient_attempts' | 'insufficient_failures' | 'below_threshold' | 'triggered'
  shouldTrigger: boolean
  thresholdBps: number | null
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value))
    return min
  return Math.min(Math.max(Math.floor(value), min), max)
}

export function sanitizeRolloutPercentageBps(value: number | null | undefined): number {
  return clampInteger(Number(value ?? 0), 0, MAX_BPS)
}

export function sanitizeRolloutCacheTtlSeconds(value: number | null | undefined): number {
  return clampInteger(Number(value ?? DEFAULT_ROLLOUT_CACHE_TTL_SECONDS), 60, 31536000)
}

export function randomPercentageBps(): number {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return Math.floor((values[0] / 0x100000000) * MAX_BPS)
}

export function getDeltaProbabilityBps(previousBps: number, nextBps: number): number {
  const previous = sanitizeRolloutPercentageBps(previousBps)
  const next = sanitizeRolloutPercentageBps(nextBps)
  if (next <= previous || previous >= MAX_BPS)
    return 0
  return Math.ceil(((next - previous) * MAX_BPS) / (MAX_BPS - previous))
}

function isMatchingCachedDecision(input: RolloutDecisionInput, cached: RolloutDecisionCachePayload | null | undefined): cached is RolloutDecisionCachePayload {
  return Boolean(cached)
    && cached!.rollout_id === input.rolloutId
    && cached!.rollout_version === input.rolloutVersionId
    && typeof cached!.selected === 'boolean'
}

function buildPayload(input: RolloutDecisionInput, selected: boolean, percentageBps: number): RolloutDecisionCachePayload {
  const now = (input.now ?? new Date()).toISOString()
  return {
    selected,
    percentage_bps: sanitizeRolloutPercentageBps(percentageBps),
    rollout_id: input.rolloutId,
    rollout_version: input.rolloutVersionId,
    created_at: now,
    updated_at: now,
  }
}

function updatePayload(input: RolloutDecisionInput, cached: RolloutDecisionCachePayload, selected: boolean, percentageBps: number): RolloutDecisionCachePayload {
  return {
    ...cached,
    selected,
    percentage_bps: sanitizeRolloutPercentageBps(percentageBps),
    updated_at: (input.now ?? new Date()).toISOString(),
  }
}

export function resolveRolloutDecision(input: RolloutDecisionInput): RolloutDecisionResult {
  const percentageBps = sanitizeRolloutPercentageBps(input.rolloutPercentageBps)
  const ttlSeconds = sanitizeRolloutCacheTtlSeconds(input.rolloutCacheTtlSeconds)
  const cached = isMatchingCachedDecision(input, input.cachePayload) ? input.cachePayload : null
  const reportsRolloutVersion = input.currentVersionName === input.rolloutVersionName
  const hasCachedRejection = cached?.selected === false

  if (!input.rolloutEnabled) {
    return {
      selected: false,
      shouldWriteCache: false,
      payload: cached,
      reason: 'disabled',
      ttlSeconds,
    }
  }

  if (reportsRolloutVersion && !hasCachedRejection) {
    return {
      selected: true,
      shouldWriteCache: true,
      payload: cached?.selected ? updatePayload(input, cached, true, Math.max(cached.percentage_bps, percentageBps)) : buildPayload(input, true, percentageBps),
      reason: 'already_on_rollout',
      ttlSeconds,
    }
  }

  if (input.rolloutPausedAt) {
    return {
      selected: false,
      shouldWriteCache: false,
      payload: cached,
      reason: 'paused',
      ttlSeconds,
    }
  }

  if (percentageBps <= 0) {
    return {
      selected: false,
      shouldWriteCache: false,
      payload: cached,
      reason: 'percentage_zero',
      ttlSeconds,
    }
  }
  const randomBps = input.randomBps ?? randomPercentageBps

  if (cached?.selected) {
    if (percentageBps >= cached.percentage_bps) {
      return {
        selected: true,
        shouldWriteCache: false,
        payload: cached,
        reason: 'cached_selected',
        ttlSeconds,
      }
    }

    const selected = randomBps() < Math.ceil((percentageBps * MAX_BPS) / cached.percentage_bps)
    return {
      selected,
      shouldWriteCache: true,
      payload: updatePayload(input, cached, selected, percentageBps),
      reason: 'percentage_decrease_reroll',
      ttlSeconds,
    }
  }

  if (cached) {
    if (percentageBps <= cached.percentage_bps) {
      return {
        selected: false,
        shouldWriteCache: false,
        payload: cached,
        reason: 'cached_unselected',
        ttlSeconds,
      }
    }

    const selected = randomBps() < getDeltaProbabilityBps(cached.percentage_bps, percentageBps)
    return {
      selected,
      shouldWriteCache: true,
      payload: updatePayload(input, cached, selected, percentageBps),
      reason: 'delta_reroll',
      ttlSeconds,
    }
  }

  const selected = randomBps() < percentageBps
  return {
    selected,
    shouldWriteCache: true,
    payload: buildPayload(input, selected, percentageBps),
    reason: 'cache_miss',
    ttlSeconds,
  }
}

async function hashDeviceId(deviceId: string): Promise<string> {
  const bytes = new TextEncoder().encode(deviceId)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function getRolloutDecision(c: Context, input: Omit<RolloutDecisionInput, 'cachePayload'>): Promise<RolloutDecisionResult> {
  const cache = new CacheHelper(c)
  const deviceHash = await hashDeviceId(input.deviceId)
  const request = cache.buildRequest('/cache/rollouts/v1', {
    app_id: input.appId,
    channel_id: String(input.channelId),
    device: deviceHash,
    rollout_id: input.rolloutId,
  })
  const cached = await cache.matchJson<RolloutDecisionCachePayload>(request)
  const decision = resolveRolloutDecision({ ...input, cachePayload: cached })

  if (decision.shouldWriteCache && decision.payload)
    await cache.putJson(request, decision.payload, decision.ttlSeconds)

  return decision
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value)
    return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1)
    throw new Error('p must be between 0 and 1')

  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  const phigh = 1 - plow

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export function wilsonLowerBoundBps(failures: number, attempts: number, confidence: number): number {
  if (attempts <= 0)
    return 0

  const boundedConfidence = Math.min(Math.max(confidence, 0.0001), 0.9999)
  const z = normalQuantile(1 - ((1 - boundedConfidence) / 2))
  const phat = failures / attempts
  const z2 = z * z
  const denominator = 1 + z2 / attempts
  const centre = phat + z2 / (2 * attempts)
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * attempts)) / attempts)
  return sanitizeRolloutPercentageBps(((centre - margin) / denominator) * MAX_BPS)
}

export function evaluateAutoPausePolicy(input: AutoPauseEvaluationInput): AutoPauseEvaluationResult {
  const attempts = Math.max(0, Math.floor(input.installs + input.failures))
  const failures = Math.max(0, Math.floor(input.failures))
  const failureRateBps = attempts > 0 ? sanitizeRolloutPercentageBps((failures / attempts) * MAX_BPS) : 0
  const thresholdBps = input.failureRateBps == null ? null : sanitizeRolloutPercentageBps(input.failureRateBps)
  const lowerBoundBps = wilsonLowerBoundBps(failures, attempts, input.confidence)

  const base = {
    action: input.action,
    attempts,
    failureRateBps,
    lowerBoundBps,
    thresholdBps,
  }

  if (!input.enabled) {
    return { ...base, shouldTrigger: false, reason: 'disabled' }
  }

  if (thresholdBps === null) {
    return { ...base, shouldTrigger: false, reason: 'missing_threshold' }
  }

  const lastTriggeredAt = parseDate(input.lastTriggeredAt)
  const cooldownMs = Math.max(0, input.cooldownMinutes) * 60 * 1000
  if (lastTriggeredAt && cooldownMs > 0 && lastTriggeredAt.getTime() + cooldownMs > (input.now ?? new Date()).getTime()) {
    return { ...base, shouldTrigger: false, reason: 'cooldown' }
  }

  if (input.minAttempts != null && attempts < input.minAttempts) {
    return { ...base, shouldTrigger: false, reason: 'insufficient_attempts' }
  }

  if (input.minFailures != null && failures < input.minFailures) {
    return { ...base, shouldTrigger: false, reason: 'insufficient_failures' }
  }

  if (failures === 0) {
    return { ...base, shouldTrigger: false, reason: 'below_threshold' }
  }

  if (lowerBoundBps < thresholdBps) {
    return { ...base, shouldTrigger: false, reason: 'below_threshold' }
  }

  return { ...base, shouldTrigger: true, reason: 'triggered' }
}
