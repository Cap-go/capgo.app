import type { PostHogQueueEnv } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import type { DispatchJob, Evaluation, MutationContext, RunRecord } from './contracts.ts'
import type { DispatchStore } from './store.ts'
import { buildEligibilityAudit } from './audit.ts'

export async function processDispatchJob(job: DispatchJob, store: DispatchStore, helpers: MutationContext | ((run: RunRecord) => MutationContext), evaluation: Evaluation, queue?: PostHogQueueEnv['POSTHOG_QUEUE']) {
  const run = await store.claimRun(job)
  if (!run)
    return { duplicate: true }
  let phase = 'finder'
  try {
    let users = run.eligible_users
    if (!run.evaluated_at) {
      users = await store.readOnly(evaluation.findEligibleUsers)
      phase = 'selection_persist'
      await store.saveSelection(run, users, buildEligibilityAudit(run.id, evaluation.key, users))
    }
    // Every selection part must be handed off before business mutations. The
    // saved snapshot and event UUIDs survive consumer/publication crashes.
    phase = 'eligibility_queue'
    await store.flushRunAudit(run.id, queue)
    phase = 'handler'
    const result = await evaluation.handleEligibleUsers(typeof helpers === 'function' ? helpers(run) : helpers, users ?? [])
    phase = 'completion'
    await store.completeRun(run, result)
    // Completion is durable before this best-effort handoff. An analytics
    // outage must never turn completed business work back into a retry.
    try {
      await store.flushRunAudit(run.id, queue)
    }
    catch { /* Cron relays pending intents independently. */ }
    return result
  }
  catch {
    await store.failRun(run, phase)
    throw new Error('Evaluation processing failed')
  }
}
