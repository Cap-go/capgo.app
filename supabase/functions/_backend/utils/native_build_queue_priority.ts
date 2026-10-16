/** Must match SQL: native_build_queue_aging_interval_seconds(). */
export const NATIVE_BUILD_QUEUE_AGING_INTERVAL_SECONDS = 300

/** Must match SQL: native_build_queue_aging_points_per_interval(). */
export const NATIVE_BUILD_QUEUE_AGING_POINTS_PER_INTERVAL = 1

/** Must match SQL: native_build_queue_max_aging_bonus(). */
export const NATIVE_BUILD_QUEUE_MAX_AGING_BONUS = 90

export type NativeBuildQueueTier = 'standard' | 'elevated' | 'high' | 'highest'

export function nativeBuildQueueTierFromPriority(priority: number): NativeBuildQueueTier {
  if (priority >= 100)
    return 'highest'
  if (priority >= 40)
    return 'high'
  if (priority >= 20)
    return 'elevated'
  return 'standard'
}

export function isTopNativeBuildQueueTier(tier: NativeBuildQueueTier): boolean {
  return tier === 'highest'
}

export function computeNativeBuildQueueAgingBonus(waitSeconds: number): number {
  if (!Number.isFinite(waitSeconds) || waitSeconds <= 0)
    return 0
  const intervals = Math.floor(waitSeconds / NATIVE_BUILD_QUEUE_AGING_INTERVAL_SECONDS)
  const bonus = intervals * NATIVE_BUILD_QUEUE_AGING_POINTS_PER_INTERVAL
  return Math.min(NATIVE_BUILD_QUEUE_MAX_AGING_BONUS, Math.max(0, bonus))
}

export function computeNativeBuildEffectiveQueuePriority(
  basePriority: number,
  enqueuedAtMs: number,
  nowMs = Date.now(),
): number {
  const waitSeconds = Math.max(0, Math.floor((nowMs - enqueuedAtMs) / 1000))
  return basePriority + computeNativeBuildQueueAgingBonus(waitSeconds)
}

export const nativeBuildQueuePriorityTestUtils = {
  computeNativeBuildQueueAgingBonus,
  computeNativeBuildEffectiveQueuePriority,
  nativeBuildQueueTierFromPriority,
}
