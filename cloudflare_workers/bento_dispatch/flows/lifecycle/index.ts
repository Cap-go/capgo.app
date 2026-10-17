import type { EligibleUser, Evaluation, ReadOnlyContext, ResolvedAction, SendOutcome } from '../../contracts.ts'
import type { Product } from './evidence.ts'
import type { Candidate } from './types.ts'
import { evaluateLifecycle } from './evaluate.ts'
import { buildLifecycleEvent } from './payload.ts'
import { hasHigherPrioritySibling, higherPrioritySiblingSql } from './priority.ts'
import { lifecycleReady } from './rollout.ts'
import { loadLifecycleInput } from './source.ts'

export function lifecycleEvaluation(product: Product): Evaluation {
  return {
    key: `lifecycle:v2:${product}`,
    everyMinutes: 1,
    findEligibleUsers: async (read) => {
      const rows = await read.query<{ org_id: string, revision: string | number, candidate: Candidate, email: string, recipient_id: string }>(`
        SELECT j.org_id, j.revision, j.candidate, LOWER(u.email) AS email, u.id AS recipient_id
        FROM public.bento_lifecycle_journeys j JOIN public.orgs o ON o.id = j.org_id
        JOIN public.users u ON u.id = o.created_by
        LEFT JOIN public.bento_event_dispatches target ON target.flow_key = 'lifecycle:v2:org'
          AND target.context_key = j.org_id::text AND target.recipient_key = 'org:' || j.org_id::text
          AND target.tag = j.candidate->>'purpose'
        WHERE j.product = $1 AND j.candidate IS NOT NULL AND target.status IS DISTINCT FROM 'accepted' AND COALESCE(target.attempt_count, 0) < 5
          AND (j.candidate->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP
          AND NOT EXISTS (${higherPrioritySiblingSql('j.org_id', 'j.product', '(j.candidate->>\'priority\')::int')})
        ORDER BY j.next_evaluation_at, j.org_id LIMIT 20`, [product])
      return rows.map(row => ({
        flowKey: 'lifecycle:v2:org',
        contextKey: row.org_id,
        recipientKey: `org:${row.org_id}`,
        email: row.email,
        tag: row.candidate.purpose,
        action: 'send',
        reason: row.candidate.branch,
        metadata: { orgId: row.org_id, product, recipientId: row.recipient_id, revision: Number(row.revision), ...row.candidate },
      }))
    },
    handleEligibleUsers: async (ctx, users) => {
      const result: SendOutcome[] = []
      // Lifecycle resolution performs several keyed source rechecks. Keep one
      // provider in flight on this pinned connection so concurrent read-only
      // transactions cannot spend the event lease waiting behind each other.
      for (const user of users)
        result.push(await ctx.sendBentoEvent(user, read => resolveLifecycle(read, user, product, ctx.settings)))
      return { selected: users.length, accepted: result.filter(item => item.outcome === 'accepted').length, failed: result.filter(item => item.outcome === 'failed').length, skipped: result.filter(item => item.outcome === 'skipped').length, deferred: result.filter(item => item.outcome === 'deferred').length }
    },
  }
}

export async function resolveLifecycle(read: ReadOnlyContext, user: EligibleUser, product: Product, settings: Readonly<Record<string, string>>): Promise<ResolvedAction> {
  if (!await lifecycleReady(read, settings))
    return { action: 'skip', reason: 'lifecycle_sender_not_ready' }
  const current = await loadLifecycleInput(read, user.contextKey, product)
  if (!current || current.revision !== user.metadata.revision || current.input.email !== user.email || current.input.recipientId !== user.metadata.recipientId)
    return { action: 'skip', reason: 'lifecycle_context_changed' }
  const candidate = evaluateLifecycle(current.input)
  if (!candidate || candidate.purpose !== user.tag || candidate.branch !== user.metadata.branch || candidate.context !== user.metadata.context
    || candidate.commercialOffer !== user.metadata.commercialOffer) {
    return { action: 'skip', reason: 'lifecycle_selection_stale' }
  }
  if (await hasHigherPrioritySibling(read, user.contextKey, product, candidate.priority))
    return { action: 'skip', reason: 'lifecycle_higher_priority_due' }
  return { action: 'send', buildEvent: id => buildLifecycleEvent(current.input, candidate, id, settings.WEBAPP_URL) }
}
