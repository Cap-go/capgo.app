import type { QueryResultRow } from 'pg'
import type { PostHogQueueEnv, PostHogQueueMessage } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import type { DispatchJob, DispatchRecord, EligibleUser, Json, QueryClient, ReadOnlyContext, RunRecord, TerminalReason } from './contracts.ts'
import { flowAudit, recordFlowEvent, safeFlowMetadata } from '../../supabase/functions/_backend/utils/bento_flow_audit.ts'
import { enqueuePostHog } from '../../supabase/functions/_backend/utils/posthog_queue.ts'
import { claimLifecycleBudget } from './flows/lifecycle/budget.ts'

export const CLAIM_LEASE_SECONDS = 120
export const MAX_DISPATCH_ATTEMPTS = 5
export const DISPATCHES_PER_MINUTE = 60
const failureCodes = new Set(['provider_rejected', 'provider_not_confirmed', 'provider_timeout', 'provider_unavailable', 'dispatch_failed', 'evaluation_failed', 'publication_failed'])
const safeError = (error: string) => failureCodes.has(error) ? error : 'dispatch_failed'
const identity = (user: EligibleUser) => [user.flowKey, user.contextKey, user.recipientKey, user.tag]

export class DispatchStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly client: QueryClient) {}

  // One pinned connection cannot interleave transactions. Provider/queue I/O
  // happens outside this serializer; each database transaction is short.
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }

  private transaction<T>(operation: (client: QueryClient) => Promise<T>, readOnly = false): Promise<T> {
    return this.serial(async () => {
      await this.client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      try {
        await this.client.query('SET LOCAL statement_timeout = 10000')
        const result = await operation(this.client)
        await this.client.query('COMMIT')
        return result
      }
      catch (error) {
        await this.client.query('ROLLBACK')
        throw error
      }
    })
  }

  readOnly<T>(operation: (ctx: ReadOnlyContext) => Promise<T>): Promise<T> {
    return this.transaction(client => operation(Object.freeze({ query: async <Row extends QueryResultRow>(sql: string, values?: unknown[]) => {
      if (!/^\s*(?:SELECT|WITH|EXPLAIN|SHOW)\b/i.test(sql) || /;\s*\S/.test(sql))
        throw new Error('Read-only query required')
      return (await client.query<Row>(sql, values)).rows
    } })), true)
  }

  async schedule(evaluationKey: string, everyMinutes: number): Promise<RunRecord | null> {
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1)
      throw new Error('Invalid evaluation cadence')
    return this.transaction(async (client) => {
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1954098942, pg_catalog.hashtext($1))', [evaluationKey])
      const unfinished = await client.query<RunRecord & { busy: boolean, exhausted: boolean }>(`
        SELECT *, (enqueue_claim_until > CURRENT_TIMESTAMP OR execution_claim_until > CURRENT_TIMESTAMP
          OR (status = 'queued' AND enqueued_at > CURRENT_TIMESTAMP - INTERVAL '2 minutes')) IS TRUE AS busy,
          (enqueue_attempt_count >= 5 OR execution_attempt_count >= 5) AS exhausted
        FROM public.bento_evaluation_runs WHERE evaluation_key = $1
          AND status IN ('pending_enqueue', 'queued', 'running') FOR UPDATE`, [evaluationKey])
      let run = unfinished.rows[0]
      if (run?.busy)
        return null
      if (run?.exhausted) {
        const audit = flowAudit('bento:evaluation_failed', run.id, { evaluation_key: evaluationKey, reason: 'attempts_exhausted' })
        await client.query(`UPDATE public.bento_evaluation_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
          enqueue_claim_token = NULL, enqueue_claim_until = NULL, execution_claim_token = NULL, execution_claim_until = NULL,
          last_error = 'attempts_exhausted', pending_audit = pending_audit || $2::jsonb WHERE id = $1`, [run.id, JSON.stringify([audit])])
        return null
      }
      if (!run) {
        const recent = await client.query(`SELECT 1 FROM public.bento_evaluation_runs WHERE evaluation_key = $1
          AND enqueued_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 minute') ORDER BY enqueued_at DESC LIMIT 1`, [evaluationKey, everyMinutes])
        if (recent.rows.length)
          return null
        const created = await client.query<RunRecord>(`INSERT INTO public.bento_evaluation_runs (evaluation_key, scheduled_for)
          VALUES ($1, CURRENT_TIMESTAMP) RETURNING *`, [evaluationKey])
        run = created.rows[0] as typeof run
      }
      const audit = flowAudit('bento:evaluation_publication_attempt', run!.id, { evaluation_key: evaluationKey, reason: 'cadence_due_or_recovery' })
      const claimed = await client.query<RunRecord>(`UPDATE public.bento_evaluation_runs SET status = 'pending_enqueue',
        enqueue_claim_token = pg_catalog.gen_random_uuid(), enqueue_claim_until = CURRENT_TIMESTAMP + INTERVAL '120 seconds',
        enqueue_attempt_count = enqueue_attempt_count + 1, pending_audit = pending_audit || $2::jsonb
        WHERE id = $1 RETURNING *`, [run!.id, JSON.stringify([audit])])
      return claimed.rows[0]!
    })
  }

  markEnqueued(id: string, token: string): Promise<boolean> {
    return this.serial(async () => (await this.client.query(`UPDATE public.bento_evaluation_runs
      SET status = CASE WHEN status = 'pending_enqueue' THEN 'queued' ELSE status END,
        enqueued_at = CURRENT_TIMESTAMP, enqueue_claim_token = NULL, enqueue_claim_until = NULL
      WHERE id = $1 AND enqueue_claim_token = $2`, [id, token])).rowCount === 1)
  }

  publicationFailed(id: string, token: string): Promise<void> {
    return this.transaction(async (client) => {
      const audit = flowAudit('bento:evaluation_publication_failed', id, { reason: 'publication_failed' })
      await client.query(`UPDATE public.bento_evaluation_runs SET enqueue_claim_token = NULL, enqueue_claim_until = NULL,
        last_error = 'publication_failed', pending_audit = pending_audit || $3::jsonb
        WHERE id = $1 AND enqueue_claim_token = $2`, [id, token, JSON.stringify([audit])])
    })
  }

  claimRun(job: DispatchJob): Promise<RunRecord | null> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1954098942, pg_catalog.hashtext($1))', [job.evaluationKey])
      const audit = flowAudit('bento:evaluation_started', job.runId, { evaluation_key: job.evaluationKey, reason: 'queue_delivery' })
      const { rows } = await client.query<RunRecord>(`UPDATE public.bento_evaluation_runs SET status = 'running',
        enqueued_at = COALESCE(enqueued_at, CURRENT_TIMESTAMP),
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP), execution_claim_token = pg_catalog.gen_random_uuid(),
        execution_claim_until = CURRENT_TIMESTAMP + INTERVAL '120 seconds', execution_attempt_count = execution_attempt_count + 1,
        pending_audit = pending_audit || $3::jsonb
        WHERE id = $1 AND evaluation_key = $2 AND status IN ('pending_enqueue', 'queued', 'running')
          AND execution_attempt_count < 5 AND (execution_claim_until IS NULL OR execution_claim_until <= CURRENT_TIMESTAMP)
        RETURNING *`, [job.runId, job.evaluationKey, JSON.stringify([audit])])
      return rows[0] ?? null
    })
  }

  private async assertRun(client: QueryClient, run: RunRecord) {
    const result = await client.query(`SELECT id FROM public.bento_evaluation_runs
      WHERE id = $1 AND execution_claim_token = $2 AND status = 'running'
        AND execution_claim_until > CURRENT_TIMESTAMP FOR UPDATE`, [run.id, run.execution_claim_token])
    if (!result.rows.length)
      throw new Error('Evaluation claim lost')
  }

  saveSelection(run: RunRecord, users: EligibleUser[], audit: PostHogQueueMessage[]): Promise<void> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      await client.query(`UPDATE public.bento_evaluation_runs SET eligible_users = $2::jsonb,
        evaluated_at = CURRENT_TIMESTAMP, pending_audit = pending_audit || $3::jsonb WHERE id = $1 AND evaluated_at IS NULL`, [run.id, JSON.stringify(users), JSON.stringify(audit)])
    })
  }

  completeRun(run: RunRecord, result: Record<string, Json>): Promise<void> {
    return this.finishRun(run, result)
  }

  failRun(run: RunRecord, phase = 'handler'): Promise<void> {
    return this.finishRun(run, undefined, phase)
  }

  private finishRun(run: RunRecord, result: Record<string, Json> | undefined, phase = 'completion'): Promise<void> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      const audit = flowAudit(result ? 'bento:evaluation_completed' : 'bento:evaluation_failed', run.id, { evaluation_key: run.evaluation_key, reason: result ? 'handled' : 'evaluation_failed', phase, result: result ?? {} })
      await client.query(`UPDATE public.bento_evaluation_runs SET
        status = CASE WHEN $3 THEN 'completed' WHEN execution_attempt_count >= 5 THEN 'failed' ELSE 'queued' END,
        finished_at = CASE WHEN $3 OR execution_attempt_count >= 5 THEN CURRENT_TIMESTAMP ELSE NULL END,
        execution_claim_token = NULL, execution_claim_until = NULL, result = $4::jsonb,
        last_error = CASE WHEN $3 THEN NULL ELSE 'evaluation_failed' END,
        pending_audit = pending_audit || $5::jsonb WHERE id = $1 AND execution_claim_token = $2`, [run.id, run.execution_claim_token, result !== undefined, JSON.stringify(result ?? {}), JSON.stringify([audit])])
    })
  }

  recordFlowEvent(run: RunRecord, user: EligibleUser, tag: string, reason: string): Promise<void> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      await recordFlowEvent(client, { ...user, tag, reason, details: user.metadata, runId: run.id })
    })
  }

  claimEvent(run: RunRecord, user: EligibleUser): Promise<DispatchRecord | null> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      const active = await client.query(`SELECT id FROM public.bento_event_dispatches
        WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND tag = 'flow:started' AND closed_at IS NULL FOR UPDATE`, identity(user).slice(0, 3))
      if (!active.rows.length) {
        await this.appendRunAudit(client, run, user, 'flow_closed')
        return null
      }
      await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1954098942, 1)')
      if (user.flowKey.startsWith('lifecycle:v2:') && !await claimLifecycleBudget(client, user)) {
        await this.appendRunAudit(client, run, user, 'lifecycle_budget_or_context_deferred')
        return null
      }
      const budget = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM (
        SELECT 1 FROM public.bento_event_dispatches
        WHERE last_attempt_at > pg_catalog.statement_timestamp() - INTERVAL '1 minute' LIMIT 60
      ) recent`)
      if (budget.rows[0]!.count >= DISPATCHES_PER_MINUTE) {
        await this.appendRunAudit(client, run, user, 'provider_budget_deferred')
        return null
      }
      await client.query(`INSERT INTO public.bento_event_dispatches (flow_key, context_key, recipient_key, tag, email, status, details)
        VALUES ($1, $2, $3, $4, $5, 'failed', $6::jsonb) ON CONFLICT (flow_key, context_key, recipient_key, tag) DO NOTHING`, [...identity(user), user.email, JSON.stringify(safeFlowMetadata({ reason: user.reason, metadata: user.metadata }))])
      if (user.flowKey.startsWith('lifecycle:v2:')) {
        await client.query(`UPDATE public.bento_event_dispatches SET email = $5, details = $6::jsonb
          WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND tag = $4
            AND status <> 'accepted' AND attempt_count < 5 AND (claim_until IS NULL OR claim_until <= CURRENT_TIMESTAMP)`, [...identity(user), user.email, JSON.stringify(safeFlowMetadata({ reason: user.reason, metadata: user.metadata }))])
      }
      const audit = flowAudit('bento:send_attempt', run.id, { flow_key: user.flowKey, context_key: user.contextKey, recipient_key: user.recipientKey, tag: user.tag, reason: user.reason }, user.recipientKey)
      const result = await client.query<DispatchRecord>(`UPDATE public.bento_event_dispatches SET status = 'sending',
        claim_token = pg_catalog.gen_random_uuid(), claim_until = CURRENT_TIMESTAMP + INTERVAL '120 seconds',
        attempt_count = attempt_count + 1, last_attempt_at = CURRENT_TIMESTAMP, last_run_id = $5,
        updated_at = CURRENT_TIMESTAMP, pending_audit = pending_audit || $6::jsonb
        WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND tag = $4
          AND status <> 'accepted' AND attempt_count < 5 AND (claim_until IS NULL OR claim_until <= CURRENT_TIMESTAMP)
        RETURNING *`, [...identity(user), run.id, JSON.stringify([audit])])
      if (!result.rows.length) {
        const state = await client.query<{ status: string, attempt_count: number }>(`SELECT status, attempt_count FROM public.bento_event_dispatches
          WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND tag = $4`, identity(user))
        let reason = 'event_claim_busy'
        if (state.rows[0]?.attempt_count >= 5)
          reason = 'event_attempts_exhausted'
        if (state.rows[0]?.status === 'accepted')
          reason = 'event_already_accepted'
        await this.appendRunAudit(client, run, user, reason)
      }
      return result.rows[0] ?? null
    })
  }

  private async appendRunAudit(client: QueryClient, run: RunRecord, user: EligibleUser, reason: string) {
    const audit = flowAudit('bento:action_skipped', run.id, { context_key: user.contextKey, recipient_key: user.recipientKey, tag: user.tag, reason }, user.recipientKey)
    await client.query('UPDATE public.bento_evaluation_runs SET pending_audit = pending_audit || $2::jsonb WHERE id = $1', [run.id, JSON.stringify([audit])])
  }

  skip(run: RunRecord, user: EligibleUser, reason: string): Promise<void> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      await this.appendRunAudit(client, run, user, reason)
    })
  }

  acceptEvent(run: RunRecord, event: DispatchRecord, user: EligibleUser): Promise<boolean> {
    return this.eventResult(run, event, user)
  }

  failEvent(run: RunRecord, event: DispatchRecord, user: EligibleUser, code: string): Promise<boolean> {
    return this.eventResult(run, event, user, safeError(code))
  }

  releaseEvent(run: RunRecord, event: DispatchRecord, user: EligibleUser, reason: string): Promise<void> {
    return this.transaction(async (client) => {
      const audit = flowAudit('bento:action_skipped', run.id, { dispatch_id: event.id, context_key: user.contextKey, recipient_key: user.recipientKey, tag: user.tag, reason }, user.recipientKey)
      await client.query(`UPDATE public.bento_event_dispatches SET status = 'failed', claim_token = NULL,
        claim_until = NULL, last_error = 'selection_stale', updated_at = CURRENT_TIMESTAMP,
        pending_audit = pending_audit || $3::jsonb WHERE id = $1 AND claim_token = $2 AND status = 'sending'`, [event.id, event.claim_token, JSON.stringify([audit])])
    })
  }

  private eventResult(run: RunRecord, event: DispatchRecord, user: EligibleUser, failure?: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const audit = flowAudit(failure ? 'bento:provider_failed' : 'bento:provider_accepted', run.id, { dispatch_id: event.id, flow_key: user.flowKey, context_key: user.contextKey, recipient_key: user.recipientKey, tag: user.tag, reason: failure ?? 'provider_acknowledged', attempt: event.attempt_count }, user.recipientKey)
      // Genuine acceptance remains valid after expiry if no new event owner has
      // replaced the claim. Telemetry handoff cannot undo this marker.
      const result = await client.query(`UPDATE public.bento_event_dispatches SET status = $3,
        event_at = CASE WHEN $3 = 'accepted' THEN CURRENT_TIMESTAMP ELSE event_at END,
        claim_token = NULL, claim_until = CASE WHEN $3 = 'failed' THEN CURRENT_TIMESTAMP + INTERVAL '1 minute' ELSE NULL END,
        last_error = $4, last_run_id = $5, updated_at = CURRENT_TIMESTAMP, pending_audit = pending_audit || $6::jsonb
        WHERE id = $1 AND claim_token = $2 AND status = 'sending'`, [event.id, event.claim_token, failure ? 'failed' : 'accepted', failure ?? null, run.id, JSON.stringify([audit])])
      if (!failure && result.rowCount === 1 && user.flowKey.startsWith('lifecycle:v2:')) {
        await client.query(`UPDATE public.bento_lifecycle_journeys SET candidate = NULL, revision = revision + 1, next_evaluation_at = CURRENT_TIMESTAMP
          WHERE org_id = $1::uuid AND product = $2`, [user.metadata.orgId, user.metadata.product])
      }
      return result.rowCount === 1
    })
  }

  endFlow(run: RunRecord, user: EligibleUser, reason: TerminalReason): Promise<void> {
    return this.transaction(async (client) => {
      await this.assertRun(client, run)
      const closed = await client.query(`UPDATE public.bento_event_dispatches SET closed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP, last_run_id = $4
        WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND tag = 'flow:started' AND closed_at IS NULL RETURNING id`, [user.flowKey, user.contextKey, user.recipientKey, run.id])
      if (!closed.rows.length)
        return
      const audit = flowAudit('bento:flow_ended', run.id, { flow_key: user.flowKey, context_key: user.contextKey, recipient_key: user.recipientKey, reason }, user.recipientKey)
      await client.query(`INSERT INTO public.bento_event_dispatches
        (flow_key, context_key, recipient_key, email, tag, status, event_at, details, last_run_id, pending_audit)
        VALUES ($1, $2, $3, $4, 'flow:ended', 'recorded', CURRENT_TIMESTAMP, $5::jsonb, $6, $7::jsonb)
        ON CONFLICT (flow_key, context_key, recipient_key, tag) DO NOTHING`, [user.flowKey, user.contextKey, user.recipientKey, user.email, JSON.stringify({ reason, metadata: safeFlowMetadata(user.metadata) }), run.id, JSON.stringify([audit])])
    })
  }

  private async flushAudit(table: 'bento_evaluation_runs' | 'bento_event_dispatches', id: string, queue: PostHogQueueEnv['POSTHOG_QUEUE'], budget?: { events: number, deadline: number }) {
    const result = await this.serial(() => this.client.query<{ pending_audit: PostHogQueueMessage[] }>(`SELECT pending_audit FROM public.${table} WHERE id = $1`, [id]))
    for (const audit of result.rows[0]?.pending_audit ?? []) {
      if (budget && (budget.events-- <= 0 || Date.now() >= budget.deadline))
        return
      await enqueuePostHog(queue, audit)
      // Remove only the ID handed off. Concurrent appended intents survive.
      await this.serial(() => this.client.query(`UPDATE public.${table} SET pending_audit =
        COALESCE((SELECT jsonb_agg(item ORDER BY ordinal) FROM jsonb_array_elements(pending_audit) WITH ORDINALITY AS a(item, ordinal)
          WHERE item->>'event_id' <> $2), '[]'::jsonb) WHERE id = $1`, [id, audit.event_id]))
    }
  }

  flushRunAudit(id: string, queue: PostHogQueueEnv['POSTHOG_QUEUE']): Promise<void> {
    return this.flushAudit('bento_evaluation_runs', id, queue)
  }

  async flushFlowAudit(user: EligibleUser, queue: PostHogQueueEnv['POSTHOG_QUEUE']) {
    const result = await this.serial(() => this.client.query<{ id: string }>(`SELECT id FROM public.bento_event_dispatches
      WHERE flow_key = $1 AND context_key = $2 AND recipient_key = $3 AND pending_audit <> '[]'::jsonb`, identity(user).slice(0, 3)))
    for (const row of result.rows)
      await this.flushAudit('bento_event_dispatches', row.id, queue)
  }

  async relayPendingAudit(queue: PostHogQueueEnv['POSTHOG_QUEUE'], limit = 50) {
    // Indexed, bounded audit-only sweep, independent of evaluation cadence.
    const budget = { events: 100, deadline: Date.now() + 10_000 }
    for (const table of ['bento_evaluation_runs', 'bento_event_dispatches'] as const) {
      const result = await this.serial(() => this.client.query<{ id: string }>(`SELECT id FROM public.${table} WHERE pending_audit <> '[]'::jsonb ORDER BY id LIMIT $1`, [limit]))
      for (const row of result.rows) {
        if (budget.events <= 0 || Date.now() >= budget.deadline)
          return
        await this.flushAudit(table, row.id, queue, budget)
      }
    }
  }
}
