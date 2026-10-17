import type { AppEvidence, Fact, Product } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import type { AcceptedPurpose, JourneyState, LifecycleInput } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'
import { describe, expect, it } from 'vitest'
import { evaluateLifecycle } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evaluate.ts'
import { reconcileProgress } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/progress.ts'
import { progressCandidate, recoveryCandidate } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/recovery.ts'
import { trialCandidate, trialReserved } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/trial.ts'
import { DAY, HOUR, reminderContext } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'

const START = Date.parse('2026-10-01T00:00:00Z')
const MINUTE = 60 * 1000
const at = (day: number, hours = 0, minutes = 0) => new Date(START + day * DAY + hours * HOUR + minutes * MINUTE).toISOString()

function evidence(overrides: Partial<AppEvidence> = {}): AppEvidence {
  return {
    appId: 'com.example.lifecycle',
    incarnation: '11111111-1111-4111-8111-111111111111',
    createdAt: at(0),
    name: 'Example app',
    product: 'ota',
    platform: null,
    selected: true,
    healthy: true,
    activeUntil: null,
    facts: [],
    tasks: { login_cli_mcp: 'pending', add_channel: 'pending', add_updater: 'pending', add_code: 'pending', run_device: 'pending', upload_bundle: 'pending', test_update: 'pending' },
    checklistComplete: false,
    firstValue: null,
    fundingBlocked: false,
    ...overrides,
  }
}

function journey(overrides: Partial<JourneyState> = {}): JourneyState {
  return { enrolledAt: at(0), lastProgressAt: at(0), appLessSince: null, checklistCompleteAt: null, firstValueAt: null, batch: null, ...overrides }
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
    evidence: evidence(),
    sourceHealthy: true,
    state: journey(),
    accepted: [],
    trialDeadline: null,
    billingHealthy: true,
    paid: false,
    compatibleCredits: false,
    plan: { name: 'Example', monthlyPrice: 19, reason: 'Fits your current usage', includes: 'Updates and builds' },
    ...overrides,
  }
}

function fact(id: string, when: string, kind: Fact['kind'] = 'task', step = 'add_channel'): Fact {
  return { id, at: when, kind, step, acknowledgement: 'Created the channel' }
}

function sent(purpose: string, acceptedAt: string, context = '', product: Product = 'ota'): AcceptedPurpose {
  return { purpose, acceptedAt, context, product }
}

function withBatch(overrides: Partial<LifecycleInput> = {}, facts = [fact('channel', at(0, 1))]): LifecycleInput {
  const app = evidence({ facts })
  return input({
    now: at(0, 1, 15),
    evidence: app,
    state: reconcileProgress(journey(), app, facts, facts.at(-1)!.at, [], 'batch-1'),
    ...overrides,
  })
}

describe('lifecycle progress collection', () => {
  it.concurrent('opens one fixed 15-minute collection window and lets later completions join', () => {
    const first = fact('channel', at(0, 1))
    const second = fact('updater', at(0, 1, 10), 'task', 'add_updater')
    const app = evidence({ facts: [first, second] })
    const opened = reconcileProgress(journey(), app, [first], at(0, 1), [], 'batch-1')
    const joined = reconcileProgress(opened, app, [second], at(0, 1, 10), [], 'unused-key')
    expect(joined.batch).toMatchObject({ key: 'batch-1', openedAt: first.at, lastAt: second.at })
    expect(joined.batch?.facts).toEqual([first, second])
    expect(progressCandidate(input({ now: at(0, 1, 14), evidence: app, state: joined }))).toBeNull()
    expect(progressCandidate(input({ now: at(0, 1, 15), evidence: app, state: joined }))?.branch).toBe('progress_digest')
  })

  it.concurrent('collects distinct fresh facts sharing a timestamp without replacing or resetting the batch', () => {
    const first = fact('channel', at(0, 1))
    const second = fact('updater', first.at, 'task', 'add_updater')
    const app = evidence({ facts: [first, second] })
    const opened = reconcileProgress(journey(), app, [first], at(0, 1), [], 'batch-1')
    const joined = reconcileProgress(opened, app, [second, second, first], at(0, 1, 1), [], 'unused-key')
    expect(joined.batch?.facts).toEqual([first, second])
    expect(joined.batch?.openedAt).toBe(first.at)
    expect(joined.lastProgressAt).toBe(first.at)
  })

  it.concurrent('keeps observing historical facts separate from earning new progress', () => {
    const old = fact('historic-channel', at(0, 1))
    const app = evidence({ facts: [old], checklistComplete: true })
    const state = reconcileProgress(journey(), app, [], at(4), [], 'unused-key')
    expect(state.batch).toBeNull()
    expect(state.lastProgressAt).toBe(at(0))
    expect(state.checklistCompleteAt).toBe(at(4))
    expect(progressCandidate(input({ evidence: app, state, now: at(4) }))).toBeNull()
  })

  it.concurrent('recognizes verified first value arriving after a manually completed checklist at the same timestamp', () => {
    const completed = fact('checklist-test', at(0, 1), 'task', 'test_update')
    const value = fact('verified-bundle-23', completed.at, 'value', 'test_update')
    const app = evidence({ facts: [completed, value], checklistComplete: true, firstValue: value })
    const before = journey({ lastProgressAt: completed.at, checklistCompleteAt: completed.at })
    const state = reconcileProgress(before, app, [value], at(0, 1, 1), [], 'value-batch')
    expect(state.firstValueAt).toBe(value.at)
    expect(state.batch?.facts).toEqual([value])
    expect(progressCandidate(input({ state, evidence: app, now: at(0, 1, 15) }))?.branch).toBe('first_update_success')
  })

  it.concurrent('recognizes a late verified outcome with an earlier timestamp without rewinding the inactivity clock', () => {
    const value = fact('late-verified-value', at(0, 1), 'value', 'test_update')
    const app = evidence({ facts: [value], checklistComplete: true, firstValue: value })
    const before = journey({ lastProgressAt: at(0, 1, 5), checklistCompleteAt: at(0, 1, 5) })
    const state = reconcileProgress(before, app, [value], at(0, 1, 10), [], 'late-value-batch')
    expect(state.lastProgressAt).toBe(before.lastProgressAt)
    expect(state.batch?.facts).toEqual([value])
    expect(state.batch?.openedAt).toBe(at(0, 1, 10))
    expect(progressCandidate(input({ state, evidence: app, now: at(0, 1, 15) }))).toBeNull()
    expect(progressCandidate(input({ state, evidence: app, now: at(0, 1, 25) }))?.branch).toBe('first_update_success')
  })

  it.concurrent('never reopens accepted summaries or accepts duplicate facts into their current batch', () => {
    const current = withBatch()
    expect(progressCandidate(current)?.purpose).toBe('summary:batch-1')
    const accepted = [sent('summary:batch-1', current.now)]
    expect(progressCandidate({ ...current, accepted })).toBeNull()
    expect(reconcileProgress(current.state, current.evidence, [], at(0, 2), accepted, 'unused-key').batch).toBeNull()
    expect(reconcileProgress(current.state, current.evidence, current.evidence!.facts, at(0, 1, 20), [], 'unused-key').batch?.facts).toHaveLength(1)
  })

  it.concurrent('clears stale app payloads on replacement and ignores late old-incarnation facts', () => {
    const current = withBatch()
    const replacement = evidence({ incarnation: 'replacement', facts: [], createdAt: at(0, 1, 5) })
    const state = reconcileProgress({ ...current.state, checklistCompleteAt: at(0), firstValueAt: at(0) }, replacement, current.evidence!.facts, at(0, 1, 10), [], 'replacement-batch')
    expect(state.batch).toBeNull()
    expect(state.checklistCompleteAt).toBe(at(0))
    expect(state.firstValueAt).toBe(at(0))
    expect(state.lastProgressAt).toBe(current.state.lastProgressAt)
  })

  it.concurrent('expires optional progress after a day instead of catching up a stale digest', () => {
    const current = withBatch({ now: at(1, 1) })
    expect(progressCandidate(current)).toBeNull()
    expect(reconcileProgress(current.state, current.evidence, [], at(2), [], 'unused-key').batch).toBeNull()
  })

  it.concurrent('holds optional progress during active work', () => {
    const current = withBatch()
    const app = { ...current.evidence!, activeUntil: at(0, 2) }
    expect(evaluateLifecycle({ ...current, evidence: app })).toBeNull()
    expect(evaluateLifecycle({ ...current, evidence: app, now: at(0, 2) })?.branch).toBe('progress_digest')
  })

  it.concurrent('chooses resumed or normal copy for one batch, based on new work after confirmed reminder acceptance', () => {
    const current = withBatch()
    expect(progressCandidate({ ...current, accepted: [sent('reminder:24h', at(0, 0, 59))] })?.branch).toBe('resumed_progress_digest')
    expect(progressCandidate({ ...current, accepted: [sent('reminder:24h', at(0, 1, 1))] })?.branch).toBe('progress_digest')
    expect(progressCandidate({ ...current, accepted: [sent('reminder:24h', at(0, 0, 59)), sent('resumed:ota', at(0, 1))] })?.branch).toBe('progress_digest')
    expect(progressCandidate({ ...current, accepted: [sent('reminder:24h', at(0, 0, 59), '', 'builder')] })?.branch).toBe('progress_digest')
  })

  it.concurrent('coalesces readiness and first success into the same batch without repeating consumed success or purchase purposes', () => {
    const value = fact('first-value', at(0, 1), 'value', 'test_update')
    const current = withBatch({}, [value])
    current.state.checklistCompleteAt = at(0, 1)
    expect(progressCandidate(current)?.branch).toBe('first_update_success')
    expect(progressCandidate({ ...current, accepted: [sent('success:ota', at(0))] })?.branch).toBe('checklist_complete_purchase')
    expect(progressCandidate({ ...current, accepted: [sent('success:ota', at(0)), sent('offer:ota', at(0))] })?.branch).toBe('progress_digest')
    const complete = evidence({ tasks: { test_update: 'done' }, checklistComplete: true })
    expect(evaluateLifecycle(input({ evidence: complete, state: journey({ checklistCompleteAt: at(0) }), accepted: [sent('offer:ota', at(0))] }))).toBeNull()
  })
})

describe('organization reminder purposes and recovery', () => {
  it.concurrent('requires continuous app-less eligibility for the first recovery timer', () => {
    const state = reconcileProgress(journey(), null, [], at(2), [], 'unused-key')
    expect(state.appLessSince).toBe(at(2))
    expect(recoveryCandidate(input({ now: at(2, 23), evidence: null, state }))).toBeNull()
    expect(recoveryCandidate(input({ now: at(3), evidence: null, state }))?.branch).toBe('no_app_recovery_24h')
    const samePeriod = reconcileProgress(state, null, [], at(3), [], 'unused-key')
    expect(samePeriod.appLessSince).toBe(at(2))
    const restored = reconcileProgress(samePeriod, evidence(), [], at(3), [], 'unused-key')
    expect(restored.appLessSince).toBeNull()
    expect(reconcileProgress(restored, null, [], at(4), [], 'unused-key').appLessSince).toBe(at(4))
  })

  it.concurrent('invalidates app-less reminder context when an app interrupts eligibility', () => {
    const original = input({ now: at(3), evidence: null, state: journey({ appLessSince: at(2) }) })
    const confirmed = sent('reminder:24h', at(3), reminderContext(original))
    const interrupted = input({ now: at(7), evidence: null, state: journey({ appLessSince: at(4) }), accepted: [confirmed] })
    expect(reminderContext(interrupted)).not.toBe(confirmed.context)
    expect(recoveryCandidate(interrupted)).toBeNull()
  })

  it.concurrent('requires matching confirmed first reminder and 24 hours since acceptance before the second', () => {
    const current = input({ now: at(2) })
    const context = reminderContext(current)
    expect(recoveryCandidate({ ...current, accepted: [sent('reminder:24h', at(1, 1), context)] })).toBeNull()
    expect(recoveryCandidate({ ...current, accepted: [sent('reminder:24h', at(1), context)] })?.branch).toBe('help_48h')
    expect(recoveryCandidate({ ...current, accepted: [sent('reminder:24h', at(1), 'old-context')] })).toBeNull()
  })

  it.concurrent('never replenishes reminder purposes after app replacement, recreation, or product switching', () => {
    const original = input({ now: at(1) })
    const confirmed = sent('reminder:24h', at(1), reminderContext(original))
    const replacement = input({ now: at(6), evidence: evidence({ incarnation: 'replacement' }), accepted: [confirmed] })
    expect(recoveryCandidate(replacement)).toBeNull()
    const switched = { ...replacement, product: 'builder' as const, evidence: evidence({ product: 'builder', platform: 'android', incarnation: 'replacement', tasks: { start_setup: 'pending' } }) }
    expect(recoveryCandidate(switched)).toBeNull()
    expect(recoveryCandidate({ ...original, now: at(20), accepted: [sent('reminder:final', at(6))] })).toBeNull()
  })

  it.concurrent('keeps historical readiness while allowing useful help for a replacement app', () => {
    const current = input({ state: journey({ checklistCompleteAt: at(0), firstValueAt: at(0) }) })
    expect(recoveryCandidate(current)?.branch).toBe('stall_24h')
    expect(recoveryCandidate({ ...current, evidence: evidence({ firstValue: fact('current-value', at(0), 'value') }) })).toBeNull()
  })

  it.concurrent('offers one final day-five reminder only with matching confirmed reminders and shipping intent, before day seven', () => {
    const current = input({ now: at(5) })
    const context = reminderContext(current)
    const accepted = [sent('reminder:24h', at(1), context), sent('reminder:48h', at(2), context)]
    expect(recoveryCandidate({ ...current, accepted })?.branch).toBe('final_recovery_5d')
    expect(recoveryCandidate({ ...current, accepted })?.expiresAt).toBe(at(7))
    expect(recoveryCandidate({ ...current, accepted, shippingIntent: false })).toBeNull()
    expect(recoveryCandidate({ ...current, accepted, now: at(7) })).toBeNull()
    expect(recoveryCandidate({ ...current, accepted: [accepted[0], { ...accepted[1], context: 'stale-context' }] })).toBeNull()
    expect(recoveryCandidate({ ...current, accepted, evidence: null, state: journey({ appLessSince: at(0) }) })).toBeNull()
  })

  it.concurrent('holds abandonment for unknown evidence and current support or activity holds', () => {
    const current = input({ now: at(6) })
    const context = reminderContext(current)
    current.accepted = [sent('reminder:24h', at(1), context), sent('reminder:48h', at(2), context)]
    expect(evaluateLifecycle({ ...current, evidence: evidence({ healthy: false, tasks: { add_channel: 'unknown' } }) })).toBeNull()
    expect(evaluateLifecycle({ ...current, supportHold: true })).toBeNull()
    expect(evaluateLifecycle({ ...current, evidence: evidence({ activeUntil: at(7) }) })).toBeNull()
    expect(evaluateLifecycle({ ...current, sourceHealthy: false })).toBeNull()
  })

  it.concurrent('uses the current Builder funding episode instead of a final setup nag', () => {
    const current = input({ product: 'builder', now: at(6), evidence: evidence({ product: 'builder', platform: 'ios', fundingBlocked: true, tasks: { start_setup: 'pending' } }) })
    const context = reminderContext(current)
    current.accepted = [sent('reminder:24h', at(1), context, 'builder'), sent('reminder:48h', at(2), context, 'builder')]
    expect(recoveryCandidate(current)?.branch).toBe('funding_blocked')
    expect(recoveryCandidate({ ...current, accepted: [...current.accepted, sent('funding:builder', at(5), context, 'builder')] })).toBeNull()
  })
})

describe('retained Trial phases', () => {
  it.concurrent.each([
    [7, 'trial7_unfinished'],
    [12, 'trial3_unfinished'],
    [14, 'today_unfinished'],
    [15, 'expired_unfinished'],
    [18, 'post_help_unfinished'],
    [23, 'post_value_unfinished'],
    [28, 'post_feedback_unfinished'],
  ] as const)('preserves the audited day %i campaign hook as %s', (day, branch) => {
    expect(trialCandidate(input({ now: at(day), trialDeadline: at(15) }))?.branch).toBe(branch)
  })

  it.concurrent('recomputes unsent deadlines after extension without replaying an accepted or superseded earlier phase', () => {
    const consumed = [sent('trial:today', at(14))]
    expect(trialCandidate(input({ now: at(14), trialDeadline: at(30), accepted: consumed }))).toBeNull()
    expect(trialCandidate(input({ now: at(22), trialDeadline: at(30), accepted: consumed }))).toBeNull()
    expect(trialCandidate(input({ now: at(27), trialDeadline: at(30), accepted: consumed }))).toBeNull()
    expect(trialCandidate(input({ now: at(30), trialDeadline: at(30), accepted: consumed }))?.branch).toBe('expired_unfinished')
  })

  it.concurrent('retains acceptance spacing without reviving countdowns after the actual deadline', () => {
    const delayedHalf = [sent('trial:trial7', at(10))]
    expect(trialCandidate(input({ now: at(14), trialDeadline: at(15), accepted: delayedHalf }))).toBeNull()
    expect(trialCandidate(input({ now: at(15), trialDeadline: at(15), accepted: delayedHalf }))).toBeNull()
    expect(trialCandidate(input({ now: at(17), trialDeadline: at(15), accepted: delayedHalf }))).toBeNull()
    expect(trialCandidate(input({ now: at(18), trialDeadline: at(15), accepted: delayedHalf }))?.branch).toBe('expired_unfinished')
    expect(trialReserved(input({ now: at(14, 12), trialDeadline: at(15), accepted: delayedHalf }))).toBe(false)
    expect(trialReserved(input({ now: at(17, 12), trialDeadline: at(15), accepted: delayedHalf }))).toBe(true)
  })

  it.concurrent('does not schedule a halfway countdown after a shortened two-day trial already ended', () => {
    expect(trialCandidate(input({ now: at(1), trialDeadline: at(2) }))?.branch).toBe('today_unfinished')
    expect(trialCandidate(input({ now: at(2), trialDeadline: at(2) }))?.branch).toBe('expired_unfinished')
    expect(trialCandidate(input({ now: at(7), trialDeadline: at(2) }))).toBeNull()
    expect(trialReserved(input({ now: at(6, 12), trialDeadline: at(2) }))).toBe(false)
  })

  it.concurrent('discards a delayed pre-expiry acceptance window crossing the deadline and keeps post-expiry spacing', () => {
    const accepted = [sent('trial:trial3', at(14, 23))]
    expect(trialCandidate(input({ now: at(15), trialDeadline: at(15), accepted }))).toBeNull()
    expect(trialCandidate(input({ now: at(16, 23), trialDeadline: at(15), accepted }))).toBeNull()
    expect(trialCandidate(input({ now: at(17, 23), trialDeadline: at(15), accepted }))?.branch).toBe('expired_unfinished')
  })

  it.concurrent('does not send expired catch-up phases or a catch-up burst after a long gap', () => {
    expect(trialCandidate(input({ now: at(30), trialDeadline: at(15) }))).toBeNull()
    const current = input({ now: at(28), trialDeadline: at(15) })
    const candidate = trialCandidate(current)!
    expect(candidate.purpose).toBe('trial:post_feedback')
    expect(trialCandidate({ ...current, accepted: [sent(candidate.purpose, at(28))], now: at(28, 1) })).toBeNull()
    expect(trialCandidate({ ...current, accepted: [sent(candidate.purpose, at(28))], trialDeadline: at(40), now: at(32) })).toBeNull()
  })

  it.concurrent('keeps phase identity and due time when readiness changes its next unsent copy', () => {
    const current = input({ now: at(12), trialDeadline: at(15) })
    const unfinished = trialCandidate(current)!
    const ready = trialCandidate({ ...current, state: journey({ checklistCompleteAt: at(11) }) })!
    expect(unfinished.branch).toBe('trial3_unfinished')
    expect(ready.branch).toBe('trial3_ready')
    expect(ready.purpose).toBe(unfinished.purpose)
    expect(ready.context).toBe(unfinished.context)
    expect(ready.expiresAt).toBe(unfinished.expiresAt)
    expect(trialCandidate({ ...current, state: journey({ checklistCompleteAt: at(11) }), accepted: [sent(unfinished.purpose, at(12))] })).toBeNull()
  })

  it.concurrent('suppresses upgrade pressure for paid coverage, compatible credits, unknown billing and missing ready-plan quote', () => {
    const current = input({ now: at(15), trialDeadline: at(15) })
    expect(trialCandidate({ ...current, paid: true })).toBeNull()
    expect(trialCandidate({ ...current, compatibleCredits: true })).toBeNull()
    expect(trialCandidate({ ...current, billingHealthy: false })).toBeNull()
    expect(trialCandidate({ ...current, plan: null, state: journey({ checklistCompleteAt: at(0) }) })).toBeNull()
    expect(trialReserved({ ...current, now: at(14, 12), paid: true })).toBe(false)
    expect(trialReserved({ ...current, now: at(14, 12), compatibleCredits: true })).toBe(false)
  })

  it.concurrent('retains readiness with practical replacement-app help and tolerates unknown replacement facts for reserved notices', () => {
    const current = input({ now: at(12), trialDeadline: at(15), state: journey({ checklistCompleteAt: at(1) }) })
    expect(current.evidence?.tasks.run_device).toBe('pending')
    expect(evaluateLifecycle(current)?.branch).toBe('trial3_ready')
    expect(evaluateLifecycle({ ...current, evidence: evidence({ healthy: false, tasks: { run_device: 'unknown' } }) })?.branch).toBe('trial3_ready')
    expect(evaluateLifecycle({ ...current, sourceHealthy: false, evidence: evidence({ healthy: false, tasks: { run_device: 'unknown' } }) })?.branch).toBe('trial3_ready')
    expect(evaluateLifecycle({ ...current, evidence: evidence({ selected: false }) })?.branch).toBe('trial3_ready')
    expect(evaluateLifecycle({ ...current, evidence: null })?.branch).toBe('trial3_ready')
  })

  it.concurrent('lets a due retained Trial replace a summary and reserves its next-day collision window', () => {
    const current = withBatch({ now: at(12), trialDeadline: at(15) }, [fact('recent-progress', at(11, 23, 30))])
    expect(progressCandidate(current)?.branch).toBe('progress_digest')
    expect(evaluateLifecycle(current)?.branch).toBe('trial3_unfinished')
    const reserved = withBatch({ now: at(11, 12), trialDeadline: at(15) }, [fact('recent-progress', at(11, 11))])
    expect(trialReserved(reserved)).toBe(true)
    expect(evaluateLifecycle(reserved)).toBeNull()
  })

  it.concurrent.each([
    ['ineligible creator', { creatorTreatment: false }],
    ['no consent', { consent: false }],
    ['paused guidance', { paused: true }],
    ['support hold', { supportHold: true }],
    ['failed source', { sourceHealthy: false }],
  ] satisfies Array<[string, Partial<LifecycleInput>]>)('keeps %s closed even when a Trial notice is due', (_label, overrides) => {
    expect(evaluateLifecycle(input({ now: at(12), trialDeadline: at(15), ...overrides }))).toBeNull()
  })
})
