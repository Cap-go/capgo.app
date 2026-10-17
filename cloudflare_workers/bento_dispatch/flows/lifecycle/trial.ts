import type { Candidate, LifecycleInput } from './types.ts'
import { accepted, DAY, iso, ms } from './types.ts'

// Read-only live Trial audit, 2026-10-17: 7/5/2/1/3/5/5 day
// waits. Re-anchor the first four purposes to the real deadline. The original
// "today" template is a payment-incoming hook one day before expiry; content
// must state the actual date, not falsely assert that payment is scheduled.
export const TRIAL_PHASES = [
  { key: 'trial7', offset: -8, wait: 7 },
  { key: 'trial3', offset: -3, wait: 5 },
  { key: 'today', offset: -1, wait: 2 },
  { key: 'expired', offset: 0, wait: 1 },
  { key: 'post_help', offset: 3, wait: 3 },
  { key: 'post_value', offset: 8, wait: 5 },
  { key: 'post_feedback', offset: 13, wait: 5 },
] as const

function highestAcceptedPhase(input: LifecycleInput): number {
  for (let index = TRIAL_PHASES.length - 1; index >= 0; index--) {
    if (accepted(input, `trial:${TRIAL_PHASES[index].key}`))
      return index
  }
  return -1
}

function phaseDue(input: LifecycleInput, index: number): number {
  const phase = TRIAL_PHASES[index]
  const anchorDue = ms(input.trialDeadline) + phase.offset * DAY
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
    const previous = accepted(input, `trial:${TRIAL_PHASES[previousIndex].key}`)
    if (!previous)
      continue
    // Missing earlier windows do not compress the live campaign's intervals.
    const wait = TRIAL_PHASES.slice(previousIndex + 1, index + 1).reduce((total, step) => total + step.wait, 0)
    return Math.max(anchorDue, ms(previous.acceptedAt) + wait * DAY)
  }
  return Math.max(anchorDue, ms(input.state.enrolledAt) + (index === 0 ? phase.wait * DAY : 0))
}

export function trialWindows(input: LifecycleInput) {
  if (!input.billingHealthy || input.paid || input.compatibleCredits || !Number.isFinite(ms(input.trialDeadline)))
    return []
  const consumedThrough = highestAcceptedPhase(input)
  return TRIAL_PHASES.flatMap((phase, index) => {
    if (index <= consumedThrough)
      return []
    const due = phaseDue(input, index)
    // A shortened trial or delayed acceptance must never resurrect a countdown
    // after the real deadline, even when the old relative wait would be later.
    const expiry = index < 3 ? Math.min(due + DAY, ms(input.trialDeadline)) : due + DAY
    return due < expiry ? [{ key: phase.key, due, expiry }] : []
  })
}

export function trialCandidate(input: LifecycleInput): Candidate | null {
  const now = ms(input.now)
  const windows = trialWindows(input)
  for (let index = windows.length - 1; index >= 0; index--) {
    const window = windows[index]
    if (now < window.due || now >= window.expiry)
      continue
    const ready = input.state.checklistCompleteAt !== null
    if (ready && !input.plan)
      return null
    return { branch: `${window.key}_${ready ? 'ready' : 'unfinished'}`, purpose: `trial:${window.key}`, context: input.trialDeadline!, priority: 100, expiresAt: iso(window.expiry) }
  }
  return null
}

export function trialReserved(input: LifecycleInput): boolean {
  return trialWindows(input).some(window => window.due > ms(input.now) && window.due <= ms(input.now) + DAY)
}
