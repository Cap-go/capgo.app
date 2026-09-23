export const ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES = [
  'ai_assistant',
  'hosted_builder',
  'other',
  'hand_coded',
  'no_selection_yet',
] as const

export type AdminABTestDevelopmentEnvironmentOutcomeName = typeof ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES[number]

export interface AdminABTestDevelopmentEnvironment {
  outcomes: { outcome: AdminABTestDevelopmentEnvironmentOutcomeName, count: number }[]
  total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOutcome(value: unknown): value is AdminABTestDevelopmentEnvironmentOutcomeName {
  return typeof value === 'string'
    && (ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES as readonly string[]).includes(value)
}

export function parseAdminABTestDevelopmentEnvironment(value: unknown): AdminABTestDevelopmentEnvironment | null {
  if (!isRecord(value) || !isCount(value.total)
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.length) {
    return null
  }
  const counts = new Map<AdminABTestDevelopmentEnvironmentOutcomeName, number>()
  let total = 0
  for (const item of value.outcomes) {
    if (!isRecord(item) || !isOutcome(item.outcome) || !isCount(item.count) || counts.has(item.outcome))
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
    outcomes: ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.map(outcome => ({
      outcome,
      count: counts.get(outcome) ?? 0,
    })),
  }
}

export function developmentEnvironmentPercentage(count: number, total: number): number {
  return total === 0 ? 0 : Math.round(count / total * 1000) / 10
}
