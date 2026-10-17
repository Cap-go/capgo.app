import type { Candidate, LifecycleInput } from './types.ts'
import { nextTask } from './evidence.ts'
import { accepted, DAY, HOUR, iso, ms, reminderContext } from './types.ts'

export function recoveryCandidate(input: LifecycleInput): Candidate | null {
  const { state, evidence: app } = input
  if (app?.firstValue || (app && !nextTask(app)))
    return null
  if (app?.fundingBlocked && input.product === 'builder') {
    return accepted(input, 'funding:builder') ? null : { branch: 'funding_blocked', purpose: 'funding:builder', context: reminderContext(input), priority: 60, expiresAt: iso(ms(input.now) + DAY) }
  }
  const now = ms(input.now)
  const idleSince = Math.max(ms(state.lastProgressAt), app ? 0 : ms(state.appLessSince))
  if (!Number.isFinite(idleSince))
    return null
  const idle = now - idleSince
  const first = accepted(input, 'reminder:24h')
  const second = accepted(input, 'reminder:48h')
  const context = reminderContext(input)
  // The final stop applies to the immutable organization reminder ledger.
  if (accepted(input, 'reminder:final'))
    return null
  if (!first && idle >= DAY) {
    return { branch: app ? 'stall_24h' : 'no_app_recovery_24h', purpose: 'reminder:24h', context, priority: 40, expiresAt: iso(now + DAY) }
  }
  if (first?.context === context && !second && idle >= 2 * DAY && now - ms(first.acceptedAt) >= DAY) {
    return { branch: app ? 'help_48h' : 'no_app_help_48h', purpose: 'reminder:48h', context, priority: 45, expiresAt: iso(now + DAY) }
  }
  if (app && input.shippingIntent && first?.context === context && second?.context === context
    && idle >= 5 * DAY && idle < 7 * DAY && now - ms(second.acceptedAt) >= DAY) {
    return { branch: 'final_recovery_5d', purpose: 'reminder:final', context, priority: 35, expiresAt: iso(idleSince + 7 * DAY) }
  }
  return null
}

export function progressCandidate(input: LifecycleInput): Candidate | null {
  const batch = input.state.batch
  if (!batch || !input.evidence || batch.incarnation !== input.evidence.incarnation || ms(batch.openedAt) + HOUR / 4 > ms(input.now)
    || ms(batch.lastAt) + DAY <= ms(input.now) || accepted(input, `summary:${batch.key}`)) {
    return null
  }
  const resumed = input.accepted.some(item => item.purpose.startsWith('reminder:') && item.product === input.product
    && batch.facts.some(fact => ms(item.acceptedAt) < ms(fact.at)))
  && !input.accepted.some(item => item.purpose === `resumed:${input.product}`)
  let branch = resumed ? 'resumed_progress_digest' : 'progress_digest'
  if (batch.facts.some(fact => fact.kind === 'value') && !accepted(input, `success:${input.product}`))
    branch = input.product === 'ota' ? 'first_update_success' : 'first_real_success'
  else if (input.state.checklistCompleteAt && !input.paid && !input.compatibleCredits && input.plan && !accepted(input, `offer:${input.product}`))
    branch = 'checklist_complete_purchase'
  return { branch, purpose: `summary:${batch.key}`, context: reminderContext(input), priority: 80, expiresAt: iso(ms(batch.lastAt) + DAY) }
}
