import type { QueryResult, QueryResultRow } from 'pg'
import type { PostHogQueueMessage } from '../../supabase/functions/_backend/utils/posthog_queue.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface QueryClient {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<T>>
}
export interface ReadOnlyContext {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<T[]>
}
export interface DispatchJob { version: 1, evaluationKey: string, runId: string }
export type TerminalReason = 'accepted' | 'cancelled' | 'expired' | 'removed' | 'superseded' | 'completed'
export interface EligibleUser {
  flowKey: string
  contextKey: string
  recipientKey: string
  email: string
  tag: string
  action: 'send' | 'end'
  reason: string
  metadata: { [key: string]: Json }
}
export interface BentoEvent { email: string, event: string, data: Record<string, unknown> }
export type ResolvedAction = { action: 'send', buildEvent: (id: string) => BentoEvent } | { action: 'end', reason: TerminalReason } | { action: 'skip', reason: string }
export interface SendOutcome { user: EligibleUser, outcome: 'accepted' | 'failed' | 'skipped' | 'ended' | 'deferred' }
export type ResolveAction = (ctx: ReadOnlyContext) => Promise<ResolvedAction>
export interface MutationContext {
  settings: Readonly<Record<string, string>>
  readOnly: <T>(operation: (ctx: ReadOnlyContext) => Promise<T>) => Promise<T>
  sendBentoEvent: (user: EligibleUser, resolve: ResolveAction) => Promise<SendOutcome>
  sendBentoEvents: (users: EligibleUser[], resolve: (user: EligibleUser, ctx: ReadOnlyContext) => Promise<ResolvedAction>) => Promise<SendOutcome[]>
  recordFlowEvent: (user: EligibleUser, tag: string, reason: string) => Promise<void>
  endFlow: (user: EligibleUser, resolve: ResolveAction) => Promise<void>
}
export interface Evaluation {
  key: string
  everyMinutes: number
  findEligibleUsers: (ctx: ReadOnlyContext) => Promise<EligibleUser[]>
  handleEligibleUsers: (ctx: MutationContext, users: EligibleUser[]) => Promise<Record<string, Json>>
}
export interface RunRecord extends QueryResultRow {
  id: string
  evaluation_key: string
  enqueue_claim_token: string | null
  execution_claim_token: string | null
  eligible_users: EligibleUser[] | null
  evaluated_at: Date | string | null
  pending_audit: PostHogQueueMessage[]
  result: Record<string, Json>
}
export interface DispatchRecord extends QueryResultRow {
  id: string
  flow_key: string
  context_key: string
  recipient_key: string
  email: string
  tag: string
  status: string
  claim_token: string
  attempt_count: number
}
export interface InvitationDetails extends QueryResultRow {
  email: string
  org_id: string
  org_name: string
  org_admin_name: string
  first_name: string | null
  last_name: string | null
  invite_magic_string: string | null
  is_new_user: boolean
}
