const MAX_BPS = 10000
const TWO_POW_32 = 0x100000000

export type AutoPauseAction = 'pause' | 'rollback' | 'notify'

export interface RolloutDecisionInput {
  appId: string
  channelId: number
  currentVersionName: string
  deviceId: string
  rolloutEnabled: boolean
  rolloutId: string
  rolloutPausedAt: Date | string | null
  rolloutPercentageBps: number | null | undefined
  rolloutVersionId: number
  rolloutVersionName: string
}

export interface RolloutDecisionResult {
  /** Stable bucket of this device for this rollout, in [0, 10000). */
  bucketBps: number
  percentageBps: number
  reason: 'already_on_rollout' | 'bucket_selected' | 'bucket_unselected' | 'disabled' | 'paused' | 'percentage_zero'
  selected: boolean
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

/**
 * 32-bit FNV-1a over UTF-16 code units followed by the murmur3 fmix32 finalizer.
 *
 * Why not Web Crypto SHA-256: this runs on every /updates request of a channel
 * with an active rollout. A synchronous inline hash needs no await, no
 * TextEncoder allocation and no digest buffer, and assignment needs uniformity
 * and stability rather than cryptographic strength (the inputs are not
 * secret and a device can always pick its own device_id anyway). FNV-1a alone
 * has weak avalanche on short, similar inputs (sequential device ids), so the
 * fmix32 finalizer spreads every input bit across the output before bucketing.
 */
export function stableHash32(input: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85EBCA6B)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xC2B2AE35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Deterministic rollout bucket in basis points ([0, 10000)).
 *
 * The key is salted with the rollout identity (rollout_id rotates whenever the
 * channel's rollout target changes, plus the rollout bundle id), so every new
 * rollout reshuffles the cohort, while changing the percentage of the same
 * rollout keeps each device's bucket. Because selection is `bucket < percentage`,
 * raising the percentage only adds devices and lowering it only removes the
 * devices with the highest buckets. Every worker and data centre computes the
 * same answer, so there is no per-colo state to drift.
 */
export function getRolloutBucketBps(input: Pick<RolloutDecisionInput, 'appId' | 'channelId' | 'deviceId' | 'rolloutId' | 'rolloutVersionId'>): number {
  const key = `${input.appId}\u0000${input.channelId}\u0000${input.rolloutId}\u0000${input.rolloutVersionId}\u0000${input.deviceId.toLowerCase()}`
  return Math.floor((stableHash32(key) / TWO_POW_32) * MAX_BPS)
}

export function resolveRolloutDecision(input: RolloutDecisionInput): RolloutDecisionResult {
  const percentageBps = sanitizeRolloutPercentageBps(input.rolloutPercentageBps)
  const bucketBps = getRolloutBucketBps(input)
  const base = { bucketBps, percentageBps }

  if (!input.rolloutEnabled)
    return { ...base, selected: false, reason: 'disabled' }

  // Devices already running the rollout bundle stay on it (also while paused or
  // at 0%) so they are never downgraded by a percentage change.
  if (input.currentVersionName === input.rolloutVersionName)
    return { ...base, selected: true, reason: 'already_on_rollout' }

  if (input.rolloutPausedAt)
    return { ...base, selected: false, reason: 'paused' }

  if (percentageBps <= 0)
    return { ...base, selected: false, reason: 'percentage_zero' }

  return bucketBps < percentageBps
    ? { ...base, selected: true, reason: 'bucket_selected' }
    : { ...base, selected: false, reason: 'bucket_unselected' }
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
