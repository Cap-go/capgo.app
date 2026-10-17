import type { AppEvidence, Fact } from './evidence.ts'
import type { AcceptedPurpose, JourneyState } from './types.ts'
import { DAY, iso, ms } from './types.ts'

// Facts are observed per immutable incarnation even when a different app is
// selected. Historic facts load as context and never open a fresh collection.
export function reconcileProgress(state: JourneyState, app: AppEvidence | null, fresh: Fact[], now: string, accepted: AcceptedPurpose[], batchKey: string): JourneyState {
  const next = { ...state, batch: state.batch ? { ...state.batch, facts: [...state.batch.facts] } : null }
  if (next.batch && (accepted.some(item => item.purpose === `summary:${next.batch!.key}`) || ms(next.batch.lastAt) + DAY < ms(now)))
    next.batch = null
  if (app) {
    next.appLessSince = null
    if (app.checklistComplete)
      next.checklistCompleteAt ??= now
    if (app.firstValue)
      next.firstValueAt ??= app.firstValue.at
    if (next.batch?.incarnation !== app.incarnation)
      next.batch = null
  }
  else {
    next.appLessSince ??= now
    next.batch = null
  }
  const currentFactIds = new Set(app?.facts.map(fact => fact.id) ?? [])
  const batchFactIds = new Set(next.batch?.facts.map(fact => fact.id) ?? [])
  // The caller supplies only previously unseen identities. Equal timestamps
  // can still represent distinct new work, especially an independently
  // verified outcome arriving after its checklist flag was already done.
  const genuine = [...new Map(fresh.filter(fact => currentFactIds.has(fact.id)
    && !batchFactIds.has(fact.id) && ms(fact.at) >= ms(state.enrolledAt)
    && ms(fact.at) <= ms(now) && (fact.kind === 'value' || ms(fact.at) >= ms(state.lastProgressAt)))
    .map(fact => [fact.id, fact])).values()]
  if (!app || !genuine.length)
    return next
  const latest = Math.max(...genuine.map(fact => ms(fact.at)))
  // A newly verified outcome may have happened before a later checklist
  // completion. Give that late observation its own collection opportunity;
  // keep the fact's real timestamp and the inactivity clock unchanged.
  const collectionTimes = genuine.map(fact => fact.kind === 'value' && ms(fact.at) < ms(state.lastProgressAt) ? ms(now) : ms(fact.at))
  const latestCollectedAt = Math.max(...collectionTimes)
  next.lastProgressAt = iso(Math.max(ms(state.lastProgressAt), latest))
  if (!next.batch) {
    next.batch = { key: batchKey, incarnation: app.incarnation, openedAt: iso(Math.min(...collectionTimes)), lastAt: iso(latestCollectedAt), facts: genuine }
  }
  else {
    // The opening timestamp stays fixed as later completions join the batch.
    next.batch.lastAt = iso(Math.max(ms(next.batch.lastAt), latestCollectedAt))
    next.batch.facts = [...new Map([...next.batch.facts, ...genuine].map(fact => [fact.id, fact])).values()]
  }
  return next
}
