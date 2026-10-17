import type { Candidate, LifecycleInput } from './types.ts'

const OFFER_BRANCHES = new Set(['subscription_proposition', 'checklist_complete_purchase', 'first_update_success', 'first_real_success'])
const LEGACY_OFFER_BRANCHES = new Set(['subscription_proposition', 'checklist_complete_purchase'])

export function isLifecycleCommercialOffer(input: Pick<LifecycleInput, 'paid' | 'compatibleCredits' | 'plan'>, branch: string): boolean {
  const plan = input.plan
  return OFFER_BRANCHES.has(branch) && !input.paid && !input.compatibleCredits && !!plan
    && plan.name.trim().length > 0 && Number.isFinite(plan.monthlyPrice) && plan.monthlyPrice > 0
}

export function withLifecycleCommercialMetadata(input: LifecycleInput, candidate: Candidate): Candidate {
  return { ...candidate, commercialOffer: isLifecycleCommercialOffer(input, candidate.branch) }
}

export function acceptedLifecycleCommercialOffer(branch: string, commercialOffer: unknown): boolean {
  // PostgreSQL ->> returns boolean JSON metadata as text. Old explicit sales
  // branches remain recognizable; old success alone never proves a plan ask.
  if (commercialOffer === true || commercialOffer === 'true')
    return true
  if (commercialOffer === false || commercialOffer === 'false')
    return false
  return LEGACY_OFFER_BRANCHES.has(branch)
}
