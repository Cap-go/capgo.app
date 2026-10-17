import type { Candidate, LifecycleInput } from './types.ts'
import { nextTask } from './evidence.ts'
import { trialWindows } from './trial.ts'
import { accepted, DAY, HOUR, iso, ms, reminderContext } from './types.ts'

const MINUTE = 60 * 1000
const COLLECTION = 15 * MINUTE

function hourlySlot(input: LifecycleInput, now: number): number {
  // A stable phase spreads passive polling across the hour. Exact collection,
  // reminder and Trial clocks below do not inherit this scheduling jitter.
  let hash = 2166136261
  for (const character of `${input.orgId}:${input.product}`)
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0
  const phase = hash % HOUR
  return Math.floor((now - phase) / HOUR + 1) * HOUR + phase
}

export function nextLifecycleEvaluation(input: LifecycleInput, candidate: Candidate | null): string {
  const now = ms(input.now)
  if (!input.creatorTreatment || !input.consent || !input.selected || input.paused || input.supportHold)
    return iso(now + 7 * DAY)

  const app = input.evidence
  const hasReadiness = !!input.state.checklistCompleteAt || app?.checklistComplete === true
  const hasValue = !!input.state.firstValueAt || !!app?.firstValue
  if (input.paid && (hasReadiness || hasValue))
    return iso(now + 7 * DAY)

  const latestAccepted = Math.max(...input.accepted.map(item => ms(item.acceptedAt)).filter(Number.isFinite), Number.NEGATIVE_INFINITY)
  const dailySlot = latestAccepted + DAY
  if (candidate && ms(candidate.expiresAt) > now) {
    // Accepted delivery owns the daily slot. A requested send gets a short
    // follow-up until the provider acknowledges it or its purpose expires.
    const retryAt = dailySlot > now ? dailySlot : now + COLLECTION
    return iso(Math.min(retryAt, ms(candidate.expiresAt)))
  }

  const futureTrialClocks = trialWindows(input).map(window => window.due).filter(value => Number.isFinite(value) && value > now)
  const nextTrial = Math.min(...futureTrialClocks, Number.POSITIVE_INFINITY)
  const targets = [nextTrial]
  const batch = input.state.batch
  const batchPending = batch && app && batch.incarnation === app.incarnation
    && !accepted(input, `summary:${batch.key}`) && ms(batch.lastAt) + DAY > now
  if (batchPending && input.sourceHealthy && app.healthy && app.selected) {
    const due = Math.max(ms(batch.openedAt) + COLLECTION, ms(app.activeUntil) || 0, dailySlot)
    if (due > now)
      targets.push(Math.min(due, ms(batch.lastAt) + DAY))
    else
      targets.push(now + COLLECTION)
    return iso(Math.min(...targets.filter(value => value > now)))
  }

  if (!input.sourceHealthy || !input.billingHealthy || (app && (!app.healthy || !app.selected))) {
    targets.push(hourlySlot(input, now))
    return iso(Math.min(...targets))
  }

  const activeUntil = ms(app?.activeUntil) || 0
  if (activeUntil > now) {
    targets.push(activeUntil)
    return iso(Math.min(...targets))
  }

  const first = accepted(input, 'reminder:24h')
  const second = accepted(input, 'reminder:48h')
  const final = accepted(input, 'reminder:final')
  const context = reminderContext(input)
  const idleSince = Math.max(ms(input.state.lastProgressAt), app ? 0 : ms(input.state.appLessSince) || now)
  const setupUnfinished = !app || (!app.firstValue && nextTask(app) !== null)
  if (setupUnfinished && !final && !(app?.fundingBlocked && input.product === 'builder')) {
    let reminderDue = Number.POSITIVE_INFINITY
    if (!first)
      reminderDue = idleSince + DAY
    else if (first.context === context && !second)
      reminderDue = Math.max(idleSince + 2 * DAY, ms(first.acceptedAt) + DAY)
    else if (app && input.shippingIntent && first.context === context && second?.context === context && now < idleSince + 7 * DAY)
      reminderDue = Math.max(idleSince + 5 * DAY, ms(second.acceptedAt) + DAY)
    if (reminderDue > now && reminderDue < idleSince + 7 * DAY)
      targets.push(Math.max(reminderDue, dailySlot))
  }

  const reminderExhausted = !!final || (!!first && first.context !== context)
    || (!!second && (!app || !input.shippingIntent || second.context !== context || now >= idleSince + 7 * DAY))
  // A completed checklist still needs hourly independent outcome observation.
  // Once value is known, or setup nags are exhausted, DB changes wake useful
  // new work while passive reconciliation drops to a daily cadence.
  const hourly = app && !app.firstValue && (!reminderExhausted || hasReadiness)
  targets.push(hourly ? hourlySlot(input, now) : now + DAY)
  return iso(Math.min(...targets.filter(value => value > now)))
}
