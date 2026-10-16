import type { PostHogQueueEnv } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import type { BentoEvent, EligibleUser, MutationContext, ReadOnlyContext, ResolveAction, RunRecord, SendOutcome } from './contracts.ts'
import type { DispatchStore } from './store.ts'

export function createMutationContext(store: DispatchStore, run: RunRecord, send: (event: BentoEvent) => Promise<boolean>, settings: Readonly<Record<string, string>> = {}, now = Date.now, queue?: PostHogQueueEnv['POSTHOG_QUEUE']): MutationContext {
  const deadline = now() + 40_000
  const flush = async (user: EligibleUser) => {
    try {
      await store.flushFlowAudit(user, queue)
    }
    catch {
      // Pending stable intents remain for cron; never undo acceptance.
    }
  }
  const endFlow: MutationContext['endFlow'] = async (user, resolve) => {
    const current = await store.readOnly(resolve)
    if (current.action === 'end')
      await store.endFlow(run, user, current.reason)
    else
      await store.skip(run, user, current.action === 'skip' ? current.reason : 'selection_stale')
    await flush(user)
  }
  const sendBentoEvent = async (user: EligibleUser, resolve: ResolveAction): Promise<SendOutcome> => {
    if (now() >= deadline - 15_000)
      return { user, outcome: 'deferred' }
    const before = await store.readOnly(resolve)
    if (before.action === 'end') {
      await store.endFlow(run, user, before.reason)
      await flush(user)
      return { user, outcome: 'ended' }
    }
    if (before.action === 'skip') {
      await store.skip(run, user, before.reason)
      return { user, outcome: 'skipped' }
    }
    const claim = await store.claimEvent(run, user)
    if (!claim)
      return { user, outcome: 'skipped' }
    let accepted = false
    try {
      // Resolve current source/payload after claiming as well: snapshots never
      // carry links or authorize a send after cancellation/resend/expiry.
      const current = await store.readOnly(resolve)
      if (current.action !== 'send') {
        await store.releaseEvent(run, claim, user, current.reason)
        if (current.action === 'end')
          await store.endFlow(run, user, current.reason)
        else
          await store.skip(run, user, current.reason)
        return { user, outcome: current.action === 'end' ? 'ended' : 'skipped' }
      }
      accepted = await send(current.buildEvent(claim.id))
      if (!accepted) {
        await store.failEvent(run, claim, user, 'provider_not_confirmed')
        return { user, outcome: 'failed' }
      }
      if (!await store.acceptEvent(run, claim, user))
        throw new Error('Dispatch claim lost')
      return { user, outcome: 'accepted' }
    }
    catch {
      // Remote acceptance followed by a DB write crash remains ambiguous. Keep
      // the lease; do not release a possibly accepted send for immediate replay.
      if (!accepted)
        await store.failEvent(run, claim, user, 'dispatch_failed')
      throw new Error('Dispatch processing failed')
    }
    finally {
      await flush(user)
    }
  }
  const context: MutationContext = {
    settings: Object.freeze({ ...settings }),
    readOnly: <T>(operation: (ctx: ReadOnlyContext) => Promise<T>) => store.readOnly(operation),
    sendBentoEvent,
    sendBentoEvents: async (users, resolve) => {
      const outcomes: SendOutcome[] = []
      // Five concurrent providers, no database transaction interleaving. Each
      // 10-second request fits the soft runtime and 120-second event lease.
      for (let index = 0; index < users.length; index += 5) {
        if (now() >= deadline - 15_000) {
          outcomes.push(...users.slice(index).map(user => ({ user, outcome: 'deferred' as const })))
          break
        }
        const group = await Promise.allSettled(users.slice(index, index + 5).map(user => sendBentoEvent(user, ctx => resolve(user, ctx))))
        for (const [offset, result] of group.entries()) {
          if (result.status === 'fulfilled')
            outcomes.push(result.value)
          else
            outcomes.push({ user: users[index + offset], outcome: 'failed' })
        }
      }
      return outcomes
    },
    recordFlowEvent: (user, tag, reason) => store.recordFlowEvent(run, user, tag, reason),
    endFlow,
  }
  return Object.freeze(context)
}
