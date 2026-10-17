import type { EligibleUser, QueryClient } from '../../contracts.ts'
import { higherPrioritySiblingSql } from './priority.ts'

// Called inside the existing short, serialized event-claim transaction. Its
// global provider lock also serializes the organization/person collision gate.
export async function claimLifecycleBudget(client: QueryClient, user: EligibleUser): Promise<boolean> {
  const orgId = user.metadata.orgId
  const product = user.metadata.product
  const recipientId = user.metadata.recipientId
  if (typeof orgId !== 'string' || typeof recipientId !== 'string' || (product !== 'ota' && product !== 'builder'))
    return false
  const current = await client.query(`SELECT 1 FROM public.bento_lifecycle_journeys j
    WHERE j.org_id = $1::uuid AND j.product = $2 AND j.revision = $3::bigint
      AND j.candidate->>'purpose' = $4 AND j.candidate->>'branch' = $5
      AND j.candidate->>'context' = $6 AND (j.candidate->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP
      AND NOT EXISTS (${higherPrioritySiblingSql('j.org_id', 'j.product', '(j.candidate->>\'priority\')::int')})
    FOR UPDATE`, [orgId, product, user.metadata.revision, user.tag, user.metadata.branch, user.metadata.context])
  if (!current.rows.length)
    return false
  const other = `AND NOT (flow_key = $4 AND context_key = $5 AND recipient_key = $6 AND tag = $7)`
  const recent = `flow_key LIKE 'lifecycle:v2:%' AND (status = 'accepted' OR (status = 'sending' AND claim_until > CURRENT_TIMESTAMP))`
  const result = await client.query<{ blocked: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM public.bento_event_dispatches WHERE ${recent}
      AND details->'metadata'->>'orgId' = $1 AND (CASE WHEN status = 'accepted' THEN event_at ELSE last_attempt_at END) > CURRENT_TIMESTAMP - INTERVAL '1 day' ${other})
    OR EXISTS (SELECT 1 FROM public.bento_event_dispatches WHERE ${recent}
      AND details->'metadata'->>'recipientId' = $2 AND (CASE WHEN status = 'accepted' THEN event_at ELSE last_attempt_at END) > CURRENT_TIMESTAMP - INTERVAL '1 day' ${other})
    OR (NOT $3 AND (SELECT COUNT(*) FROM (SELECT 1 FROM public.bento_event_dispatches WHERE ${recent}
      AND details->'metadata'->>'orgId' = $1 AND tag NOT LIKE 'trial:%'
      AND (CASE WHEN status = 'accepted' THEN event_at ELSE last_attempt_at END) > CURRENT_TIMESTAMP - INTERVAL '7 days' ${other} LIMIT 3) weekly) >= 3)
    OR ($8 AND EXISTS (SELECT 1 FROM public.bento_event_dispatches WHERE ${recent}
      AND details->'metadata'->>'orgId' = $1
      AND (details->'metadata'->>'commercialOffer' = 'true'
        OR details->'metadata'->>'branch' IN ('subscription_proposition', 'checklist_complete_purchase'))
      AND tag NOT LIKE 'trial:%'
      AND (CASE WHEN status = 'accepted' THEN event_at ELSE last_attempt_at END) > CURRENT_TIMESTAMP - INTERVAL '7 days' ${other})) AS blocked`, [orgId, recipientId, user.tag.startsWith('trial:'), user.flowKey, user.contextKey, user.recipientKey, user.tag, user.metadata.commercialOffer === true || user.metadata.branch === 'subscription_proposition' || user.metadata.branch === 'checklist_complete_purchase'])
  if (result.rows[0]?.blocked !== false) {
    // A deferred candidate must yield the front of the indexed cohort; its
    // immutable purpose remains unconsumed and is recomputed after the hold.
    await client.query(`UPDATE public.bento_lifecycle_journeys SET candidate = NULL, revision = revision + 1,
      next_evaluation_at = CURRENT_TIMESTAMP + INTERVAL '15 minutes'
      WHERE org_id = $1::uuid AND product = $2 AND revision = $3::bigint`, [orgId, product, user.metadata.revision])
    return false
  }
  return true
}
