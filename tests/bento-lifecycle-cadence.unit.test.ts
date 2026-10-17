import type { AppEvidence } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import type { AcceptedPurpose, Candidate, LifecycleInput } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'
import { describe, expect, it } from 'vitest'
import { nextLifecycleEvaluation } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/cadence.ts'
import { evaluateLifecycle } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evaluate.ts'
import { DAY, HOUR, reminderContext } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'

const START = Date.parse('2026-10-01T00:00:00Z')
const MINUTE = 60 * 1000
const at = (day: number, hours = 0, minutes = 0) => new Date(START + day * DAY + hours * HOUR + minutes * MINUTE).toISOString()

function app(overrides: Partial<AppEvidence> = {}): AppEvidence {
  return { appId: 'com.example.lifecycle', incarnation: 'current-app', createdAt: at(0), name: 'Example', product: 'ota', platform: null, selected: true, healthy: true, activeUntil: null, facts: [], tasks: { run_device: 'pending' }, checklistComplete: false, firstValue: null, fundingBlocked: false, ...overrides }
}

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  return {
    now: at(1),
    orgId: '22222222-2222-4222-8222-222222222222',
    orgName: 'Example organization',
    product: 'ota',
    recipientId: '33333333-3333-4333-8333-333333333333',
    email: 'lifecycle@example.com',
    creatorTreatment: true,
    consent: true,
    selected: true,
    shippingIntent: true,
    supportHold: false,
    paused: false,
    evidence: app(),
    sourceHealthy: true,
    state: { enrolledAt: at(0), lastProgressAt: at(0), appLessSince: null, checklistCompleteAt: null, firstValueAt: null, batch: null },
    accepted: [],
    trialDeadline: null,
    billingHealthy: true,
    paid: false,
    compatibleCredits: false,
    plan: { name: 'Example', monthlyPrice: 19, reason: 'Fits your usage', includes: 'Updates' },
    ...overrides,
  }
}

function sent(purpose: string, acceptedAt: string, context = ''): AcceptedPurpose {
  return { purpose, acceptedAt, context, product: 'ota' }
}

function candidate(expiresAt = at(3)): Candidate {
  return { branch: 'progress_digest', purpose: 'summary:batch', context: 'context', priority: 80, expiresAt }
}

function batched(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  const current = input({ now: at(0, 1, 7), ...overrides })
  current.state = { ...current.state, lastProgressAt: at(0, 1), batch: { key: 'batch', incarnation: 'current-app', openedAt: at(0, 1), lastAt: at(0, 1), facts: [] } }
  return current
}

describe('adaptive organization lifecycle cadence', () => {
  it.concurrent.each([
    ['creator not assigned', { creatorTreatment: false }],
    ['no consent', { consent: false }],
    ['unselected product', { selected: false }],
    ['paused journey', { paused: true }],
    ['support hold', { supportHold: true }],
  ] satisfies Array<[string, Partial<LifecycleInput>]>)('sleeps seven days for %s and relies on source-change wakeups', (_label, overrides) => {
    const current = input(overrides)
    expect(nextLifecycleEvaluation(current, null)).toBe(at(8))
  })

  it.concurrent('sleeps seven days for paid completed or historically successful journeys', () => {
    const complete = input({ paid: true, evidence: app({ checklistComplete: true }) })
    expect(nextLifecycleEvaluation(complete, null)).toBe(at(8))
    expect(nextLifecycleEvaluation({ ...complete, evidence: app(), state: { ...complete.state, firstValueAt: at(0) } }, null)).toBe(at(8))
  })

  it.concurrent('spreads unfinished app polling into stable hourly slots without waiting beyond one hour', () => {
    const current = input()
    const next = Date.parse(nextLifecycleEvaluation(current, null))
    expect(next).toBeGreaterThan(Date.parse(current.now))
    expect(next).toBeLessThanOrEqual(Date.parse(current.now) + HOUR)
    const again = nextLifecycleEvaluation({ ...current, now: new Date(next).toISOString() }, null)
    expect(Date.parse(again) - next).toBe(HOUR)
  })

  it.concurrent('retains hourly independent value checks after canonical completion, even after setup exhaustion', () => {
    const current = input({ evidence: app({ checklistComplete: true, tasks: { test_update: 'done' } }), accepted: [sent('reminder:final', at(0))] })
    current.state.checklistCompleteAt = at(0)
    expect(Date.parse(nextLifecycleEvaluation(current, null))).toBeLessThanOrEqual(Date.parse(current.now) + HOUR)
  })

  it.concurrent('drops exhausted unfinished setup and known real value to daily passive reconciliation', () => {
    const exhausted = input({ accepted: [sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(exhausted, null)).toBe(at(2))
    const value = { id: 'verified-value', at: at(0), step: 'test_update', kind: 'value' as const, acknowledgement: 'Applied your update' }
    expect(nextLifecycleEvaluation(input({ evidence: app({ firstValue: value }) }), null)).toBe(at(2))
  })

  it.concurrent('schedules the exact continuous no-app 24-hour and accepted-spaced 48-hour clocks', () => {
    const first = input({ now: at(1, 12), evidence: null })
    first.state.appLessSince = at(1)
    expect(nextLifecycleEvaluation(first, null)).toBe(at(2))
    const second = input({ now: at(2, 12), evidence: null })
    second.state.appLessSince = at(1)
    second.accepted = [sent('reminder:24h', at(2, 2), reminderContext(second))]
    expect(nextLifecycleEvaluation(second, null)).toBe(at(3, 2))
  })

  it.concurrent('does not poll consumed stale no-app reminder contexts every five minutes', () => {
    const current = input({ evidence: null, accepted: [sent('reminder:24h', at(0), 'old-app-less-context')] })
    current.state.appLessSince = at(1)
    expect(nextLifecycleEvaluation(current, null)).toBe(at(2))
  })

  it.concurrent('schedules fixed batch collection exactly, then holds for active work without resetting collection', () => {
    const current = batched()
    expect(nextLifecycleEvaluation(current, null)).toBe(at(0, 1, 15))
    expect(nextLifecycleEvaluation({ ...current, evidence: app({ activeUntil: at(0, 1, 30) }) }, null)).toBe(at(0, 1, 30))
    expect(nextLifecycleEvaluation({ ...current, state: { ...current.state, lastProgressAt: at(0, 1, 10) } }, null)).toBe(at(0, 1, 15))
    expect(current.state.batch?.openedAt).toBe(at(0, 1))
  })

  it.concurrent('waits for a running build hold rather than continuously polling its blocked reminder', () => {
    const current = input({ evidence: app({ activeUntil: at(1, 2) }) })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(1, 2))
  })

  it.concurrent('checks a requested candidate after fifteen minutes until provider acceptance', () => {
    expect(nextLifecycleEvaluation(input(), candidate())).toBe(at(1, 0, 15))
    expect(nextLifecycleEvaluation(input(), candidate(at(1, 0, 5)))).toBe(at(1, 0, 5))
  })

  it.concurrent('honors the shared organization daily slot and retires a candidate that expires sooner', () => {
    const current = input({ accepted: [sent('trial:trial7', at(0, 2))] })
    expect(nextLifecycleEvaluation(current, candidate())).toBe(at(1, 2))
    expect(nextLifecycleEvaluation(current, candidate(at(1, 1)))).toBe(at(1, 1))
  })

  it.concurrent('schedules the nearest retained Trial touch inside the next day for retired setup', () => {
    const current = input({ now: at(11, 12), evidence: null, trialDeadline: at(15), accepted: [sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(12))
  })

  it.concurrent('uses accepted post-expiry spacing without waking an invalid delayed countdown', () => {
    const current = input({ now: at(14, 12), evidence: null, trialDeadline: at(15), accepted: [sent('trial:trial7', at(10)), sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(15, 12))
    expect(nextLifecycleEvaluation({ ...current, now: at(17, 12) }, null)).toBe(at(18))
  })

  it.concurrent('does not schedule a halfway phase after a shortened two-day trial', () => {
    const current = input({ now: at(6, 12), evidence: null, trialDeadline: at(2), accepted: [sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(7, 12))
  })

  it.concurrent('skips a countdown postponed past the actual deadline by accepted delivery spacing', () => {
    const current = input({ now: at(16, 12), evidence: null, trialDeadline: at(15), accepted: [sent('trial:trial3', at(14, 23)), sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(17, 12))
    expect(nextLifecycleEvaluation({ ...current, now: at(17, 12) }, null)).toBe(at(17, 23))
  })

  it.concurrent('extensions cannot revive lower Trial phases after a later accepted purpose', () => {
    const current = input({ now: at(27), evidence: null, trialDeadline: at(30), accepted: [sent('trial:today', at(14)), sent('reminder:final', at(0))] })
    expect(nextLifecycleEvaluation(current, null)).toBe(at(28))
    expect(nextLifecycleEvaluation({ ...current, now: at(29, 12) }, null)).toBe(at(30))
  })

  it.concurrent('recovers unknown evidence on an hourly cadence and does not treat it as abandonment', () => {
    const current = input({ sourceHealthy: false, evidence: app({ healthy: false, tasks: { run_device: 'unknown' } }) })
    const next = Date.parse(nextLifecycleEvaluation(current, null))
    expect(evaluateLifecycle(current)).toBeNull()
    expect(next).toBeGreaterThan(Date.parse(current.now))
    expect(next).toBeLessThanOrEqual(Date.parse(current.now) + HOUR)
  })

  it.concurrent('can service 500 hourly journeys with a 20-per-minute budget while collection batches stay timely', () => {
    const count = 500
    const simulationStart = START + HOUR
    const jobs = Array.from({ length: count }, (_, index) => {
      const current = input({ now: at(0, 1), orgId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })
      if (index < 10) {
        current.state.lastProgressAt = at(0, 1)
        current.state.batch = { key: `batch-${index}`, incarnation: 'current-app', openedAt: at(0, 1), lastAt: at(0, 1), facts: [] }
      }
      return { input: current, next: Date.parse(nextLifecycleEvaluation(current, null)), evaluations: 0, batchHandledAt: null as number | null }
    })
    const distinctFirstSlots = new Set(jobs.slice(10).map(job => Math.floor((job.next - simulationStart) / MINUTE)))
    expect(distinctFirstSlots.size).toBeGreaterThan(50)
    let maxDelay = 0
    for (let minute = 1; minute <= 120; minute++) {
      const now = simulationStart + minute * MINUTE
      const due = jobs.filter(job => job.next <= now).sort((left, right) => left.next - right.next).slice(0, 20)
      for (const job of due) {
        maxDelay = Math.max(maxDelay, now - job.next)
        job.evaluations++
        job.input.now = new Date(now).toISOString()
        if (job.input.state.batch) {
          job.batchHandledAt = now
          job.input.accepted = [sent(`summary:${job.input.state.batch.key}`, job.input.now)]
          job.input.state.batch = null
        }
        job.next = Date.parse(nextLifecycleEvaluation(job.input, null))
      }
    }
    expect(jobs.every(job => job.evaluations >= 1)).toBe(true)
    expect(jobs.reduce((total, job) => total + job.evaluations, 0)).toBeLessThanOrEqual(1020)
    expect(maxDelay).toBeLessThanOrEqual(MINUTE)
    expect(jobs.slice(0, 10).every(job => job.batchHandledAt !== null && job.batchHandledAt <= simulationStart + 16 * MINUTE)).toBe(true)
  })

  it.concurrent('removes paid and ineligible journeys from repeated five-minute backlog pressure', () => {
    const wakeups = Array.from({ length: 500 }, (_, index) => {
      const current = input(index % 2 ? { paid: true, evidence: app({ checklistComplete: true }) } : { creatorTreatment: false })
      return Date.parse(nextLifecycleEvaluation(current, null))
    })
    expect(wakeups.every(value => value === START + 8 * DAY)).toBe(true)
    expect(wakeups.filter(value => value < START + 2 * DAY)).toHaveLength(0)
  })
})
