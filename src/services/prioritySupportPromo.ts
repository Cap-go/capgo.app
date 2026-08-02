import type { LocationQuery, LocationQueryRaw } from 'vue-router'

export type PromoVariant = 'support' | 'builder'

export interface PrioritySupportOrganization {
  paying?: boolean | null
  trial_left?: number | null
}

export interface PromoAvailability {
  supportEligible: boolean
  builderEligible: boolean
  supportReady: boolean
  builderReady: boolean
}

export function getUtcPromoDay(now = new Date()) {
  return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}`
}

export function getDailyPromoVariant(utcDay: string): PromoVariant {
  // Repeats are intentional: forced alternation would make the date-seeded choice predictable.
  let hash = 2166136261
  for (const character of utcDay)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) % 2 === 0 ? 'support' : 'builder'
}

export function choosePromoVariant(preferred: PromoVariant, availability: PromoAvailability): PromoVariant | null {
  if (!availability.supportReady || !availability.builderReady)
    return null
  if (preferred === 'support' && availability.supportEligible)
    return 'support'
  if (preferred === 'builder' && availability.builderEligible)
    return 'builder'
  if (availability.supportEligible)
    return 'support'
  if (availability.builderEligible)
    return 'builder'
  return null
}

export function isPrioritySupportEligible(organization: PrioritySupportOrganization | null | undefined) {
  return !!organization && (!!organization.paying || (organization.trial_left ?? 0) > 0)
}

export function isPrioritySupportTrial(organization: PrioritySupportOrganization | null | undefined) {
  return !!organization && !organization.paying && (organization.trial_left ?? 0) > 0
}

export async function resolvePrioritySupportEligibility(
  awaitInitialLoad: () => Promise<unknown>,
  getOrganization: () => PrioritySupportOrganization | null | undefined,
  onError?: (error: unknown) => void,
) {
  try {
    await awaitInitialLoad()
    return isPrioritySupportEligible(getOrganization())
  }
  catch (error) {
    onError?.(error)
    return false
  }
}

export function consumeGitHubConnectQuery(query: LocationQuery): LocationQueryRaw | null {
  if (query.connect !== 'github')
    return null
  const nextQuery: LocationQueryRaw = { ...query }
  delete nextQuery.connect
  return nextQuery
}
