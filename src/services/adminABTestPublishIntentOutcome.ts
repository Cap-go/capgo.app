export const ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES = [
  'selected_publish',
  'selected_another_intent',
  'no_selection_yet',
] as const

export type AdminABTestPublishIntentOutcomeName = typeof ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES[number]

export interface AdminABTestPublishIntentOutcomeCount {
  count: number
  outcome: AdminABTestPublishIntentOutcomeName
}

export interface AdminABTestPublishIntentOutcome {
  inferred_from_organization: number
  outcomes: AdminABTestPublishIntentOutcomeCount[]
  total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOutcome(value: unknown): value is AdminABTestPublishIntentOutcomeName {
  return typeof value === 'string'
    && (ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES as readonly string[]).includes(value)
}

export function parseAdminABTestPublishIntentOutcome(value: unknown): AdminABTestPublishIntentOutcome | null {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.total)
    || (value.inferred_from_organization !== undefined && !isNonNegativeInteger(value.inferred_from_organization))
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES.length) {
    return null
  }

  const counts = new Map<AdminABTestPublishIntentOutcomeName, number>()
  for (const item of value.outcomes) {
    if (!isRecord(item)
      || !isOutcome(item.outcome)
      || !isNonNegativeInteger(item.count)
      || counts.has(item.outcome)) {
      return null
    }
    counts.set(item.outcome, item.count)
  }

  const outcomes = ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES.map(outcome => ({
    outcome,
    count: counts.get(outcome) ?? 0,
  }))
  if (outcomes.reduce((sum, outcome) => sum + outcome.count, 0) !== value.total)
    return null

  const inferredFromOrganization = value.inferred_from_organization ?? 0
  const selectedTotal = outcomes
    .filter(outcome => outcome.outcome !== 'no_selection_yet')
    .reduce((sum, outcome) => sum + outcome.count, 0)
  if (inferredFromOrganization > selectedTotal)
    return null

  return {
    inferred_from_organization: inferredFromOrganization,
    outcomes,
    total: value.total,
  }
}
