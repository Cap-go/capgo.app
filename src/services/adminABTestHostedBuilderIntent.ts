export const ADMIN_AB_TEST_HOSTED_BUILDER_INTENTS = ['publish', 'builder', 'ota', 'both', 'exploring', 'no_selection_yet'] as const

export type AdminABTestHostedBuilderIntentName = typeof ADMIN_AB_TEST_HOSTED_BUILDER_INTENTS[number]

export interface AdminABTestHostedBuilderIntent {
  outcomes: { outcome: AdminABTestHostedBuilderIntentName, count: number }[]
  total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIntent(value: unknown): value is AdminABTestHostedBuilderIntentName {
  return typeof value === 'string'
    && (ADMIN_AB_TEST_HOSTED_BUILDER_INTENTS as readonly string[]).includes(value)
}

export function parseAdminABTestHostedBuilderIntent(value: unknown): AdminABTestHostedBuilderIntent | null {
  if (!isRecord(value) || !isCount(value.total)
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== ADMIN_AB_TEST_HOSTED_BUILDER_INTENTS.length) {
    return null
  }
  const counts = new Map<AdminABTestHostedBuilderIntentName, number>()
  let total = 0
  for (const item of value.outcomes) {
    if (!isRecord(item) || !isIntent(item.outcome) || !isCount(item.count) || counts.has(item.outcome))
      return null
    total += item.count
    if (!Number.isSafeInteger(total))
      return null
    counts.set(item.outcome, item.count)
  }
  if (total !== value.total)
    return null
  return {
    total: value.total,
    outcomes: ADMIN_AB_TEST_HOSTED_BUILDER_INTENTS.map(outcome => ({ outcome, count: counts.get(outcome) ?? 0 })),
  }
}
