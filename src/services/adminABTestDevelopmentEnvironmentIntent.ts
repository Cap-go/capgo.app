import type { AdminABTestDevelopmentEnvironment, AdminABTestDevelopmentEnvironmentOutcomeName } from './adminABTestDevelopmentEnvironment'
import { ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES } from './adminABTestDevelopmentEnvironment'

export const ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_INTENTS = ['publish', 'builder', 'ota', 'both', 'exploring', 'no_selection_yet'] as const

export type AdminABTestDevelopmentEnvironmentIntentName = typeof ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_INTENTS[number]

export interface AdminABTestDevelopmentEnvironmentIntent {
  outcomes: { outcome: AdminABTestDevelopmentEnvironmentIntentName, count: number }[]
  total: number
}

export type AdminABTestDevelopmentEnvironmentIntents = Record<AdminABTestDevelopmentEnvironmentOutcomeName, AdminABTestDevelopmentEnvironmentIntent>

export function parseAdminABTestDevelopmentEnvironmentIntents(value: unknown, environment: AdminABTestDevelopmentEnvironment): AdminABTestDevelopmentEnvironmentIntents | null {
  if (!isRecord(value) || Object.keys(value).length !== ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.length)
    return null
  const groups = {} as AdminABTestDevelopmentEnvironmentIntents
  for (const name of ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES) {
    const group = parseAdminABTestDevelopmentEnvironmentIntent(value[name])
    if (!group || group.total !== environment.outcomes.find(item => item.outcome === name)?.count)
      return null
    groups[name] = group
  }
  return groups
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIntent(value: unknown): value is AdminABTestDevelopmentEnvironmentIntentName {
  return typeof value === 'string'
    && (ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_INTENTS as readonly string[]).includes(value)
}

export function parseAdminABTestDevelopmentEnvironmentIntent(value: unknown): AdminABTestDevelopmentEnvironmentIntent | null {
  if (!isRecord(value) || !isCount(value.total)
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_INTENTS.length) {
    return null
  }
  const counts = new Map<AdminABTestDevelopmentEnvironmentIntentName, number>()
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
    outcomes: ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_INTENTS.map(outcome => ({ outcome, count: counts.get(outcome) ?? 0 })),
  }
}
