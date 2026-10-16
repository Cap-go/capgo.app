export type NativeBuildQueueTier = 'standard' | 'elevated' | 'high' | 'highest'

export interface BuildQueuePriorityInfo {
  queue_priority: number
  queue_priority_tier: NativeBuildQueueTier
  upgrade_url?: string
}

const TIER_LABELS: Record<NativeBuildQueueTier, string> = {
  standard: 'Standard',
  elevated: 'Elevated',
  high: 'High',
  highest: 'Highest',
}

export function formatNativeBuildQueueTierLabel(tier: NativeBuildQueueTier): string {
  return TIER_LABELS[tier] ?? tier
}

export function isTopNativeBuildQueueTier(tier: NativeBuildQueueTier): boolean {
  return tier === 'highest'
}

export function buildQueuePriorityUserLines(input: BuildQueuePriorityInfo): string[] {
  const tierLabel = formatNativeBuildQueueTierLabel(input.queue_priority_tier)
  const lines = [`Build queue priority: ${tierLabel} (base ${input.queue_priority})`]
  if (!isTopNativeBuildQueueTier(input.queue_priority_tier) && input.upgrade_url) {
    lines.push(`Upgrade your plan for higher queue priority and faster builds when the queue is busy: ${input.upgrade_url}`)
  }
  return lines
}

export const buildQueuePriorityTestUtils = {
  buildQueuePriorityUserLines,
  formatNativeBuildQueueTierLabel,
  isTopNativeBuildQueueTier,
}
