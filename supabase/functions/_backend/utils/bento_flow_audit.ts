import type { QueryResult, QueryResultRow } from 'pg'
import type { PostHogQueueMessage } from './posthog_queue.ts'
import { isForbiddenPostHogPropertyKey, messageBytes, parsePostHogMessage, POSTHOG_MESSAGE_MAX_BYTES } from './posthog_queue.ts'

export interface FlowFact {
  flowKey: string
  contextKey: string
  recipientKey: string
  email: string
  tag: string
  reason: string
  details: Record<string, unknown>
  runId?: string
  eventAt?: string
}
interface FactClient { query: <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => Promise<QueryResult<T>> }

// Token-bearing links must never enter the durable audit snapshot. Provider
// payloads are resolved separately immediately before sending.
export function safeFlowMetadata(value: unknown): unknown {
  function clean(input: unknown): unknown {
    if (Array.isArray(input))
      return input.map(clean)
    if (input && typeof input === 'object')
      return Object.fromEntries(Object.entries(input).filter(([key]) => !isForbiddenPostHogPropertyKey(key) && !/invite.?magic|invite.?link|credential|claim.?token/i.test(key)).map(([key, child]) => [key, clean(child)]))
    if (typeof input === 'string' && /https?:\/\/[^\s#&?]*[#&?]\S*(?:\s[^=&]*)?(?:token|magic|secret|key)[^=&]*=/i.test(input))
      throw new Error('Unsafe flow metadata')
    return input
  }
  return clean(value)
}

export function flowAudit(event: string, runId: string, properties: Record<string, unknown>, distinctId = 'bento-evaluations'): PostHogQueueMessage {
  const timestamp = new Date().toISOString()
  const body = {
    version: 1 as const,
    source: 'private_events' as const,
    event_id: crypto.randomUUID(),
    accepted_at: timestamp,
    request_id: runId,
    payload: { event, channel: 'bento_evaluation', distinct_id: distinctId, timestamp, setPersonProperties: false, nonPersonTags: safeFlowMetadata({ run_id: runId, ...properties }) as Record<string, unknown> },
  }
  if (messageBytes(body) > POSTHOG_MESSAGE_MAX_BYTES || !parsePostHogMessage(body))
    throw new Error('Invalid flow audit')
  return body
}

// The caller owns the transaction. The API sender invokes this beside its
// sent_at write, while evaluation helpers invoke it in their claim transaction.
export async function recordFlowEvent(client: FactClient, fact: FlowFact) {
  const id = crypto.randomUUID()
  // The private ledger retains complete domain details. Audit only the stable
  // reference and decision so deep/large details cannot prevent fact recording.
  const audit = flowAudit('bento:flow_event_recorded', fact.runId ?? fact.contextKey, { dispatch_id: id, flow_key: fact.flowKey, context_key: fact.contextKey, recipient_key: fact.recipientKey, tag: fact.tag, reason: fact.reason }, fact.recipientKey)
  await client.query(`INSERT INTO public.bento_event_dispatches
    (flow_key, context_key, recipient_key, email, tag, status, event_at, details, last_run_id, pending_audit, id)
    VALUES ($1, $2, $3, $4, $5, 'recorded', COALESCE($6::timestamptz, CURRENT_TIMESTAMP), $7::jsonb, $8::uuid, $9::jsonb, $10::uuid)
    ON CONFLICT (flow_key, context_key, recipient_key, tag) DO NOTHING`, [fact.flowKey, fact.contextKey, fact.recipientKey, fact.email.toLowerCase(), fact.tag, fact.eventAt ?? null, JSON.stringify(fact.details), fact.runId ?? null, JSON.stringify([audit]), id])
}
