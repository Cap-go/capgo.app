import type { Candidate, LifecycleInput } from './types.ts'
import { withLifecycleCommercialMetadata } from './commercial.ts'
import { progressCandidate, recoveryCandidate } from './recovery.ts'
import { trialCandidate, trialReserved } from './trial.ts'
import { accepted, DAY, iso, ms } from './types.ts'

export function evaluateLifecycle(input: LifecycleInput): Candidate | null {
  if (!input.creatorTreatment || !input.consent || !input.selected || input.paused || input.supportHold || !input.billingHealthy)
    return null
  // Retained ready notices rely on durable organization readiness and current
  // billing, not on the health or selection of a replaceable app's telemetry.
  const trial = input.sourceHealthy || input.state.checklistCompleteAt ? trialCandidate(input) : null
  if (trial)
    return withLifecycleCommercialMetadata(input, trial)
  if (!input.sourceHealthy || (input.evidence && (!input.evidence.selected || !input.evidence.healthy)) || ms(input.evidence?.activeUntil) > ms(input.now))
    return null
  if (trialReserved(input))
    return null
  const progress = progressCandidate(input)
  if (progress)
    return withLifecycleCommercialMetadata(input, progress)
  const recovery = recoveryCandidate(input)
  if (recovery)
    return withLifecycleCommercialMetadata(input, recovery)
  if (input.state.checklistCompleteAt && input.plan && !input.paid && !input.compatibleCredits
    && !accepted(input, `offer:${input.product}`)
    && !input.accepted.some(item => item.product === input.product && item.purpose.startsWith('summary:') && ms(item.acceptedAt) + DAY > ms(input.now))) {
    return withLifecycleCommercialMetadata(input, { branch: 'subscription_proposition', purpose: `offer:${input.product}`, context: input.state.checklistCompleteAt, priority: 20, expiresAt: iso(ms(input.now) + DAY) })
  }
  return null
}
