import type { EligibleUser } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { buildEligibilityAudit } from '../cloudflare_workers/bento_dispatch/audit.ts'
import { processDispatchJob } from '../cloudflare_workers/bento_dispatch/consumer.ts'
import { DispatchStore } from '../cloudflare_workers/bento_dispatch/store.ts'
import { parsePostHogMessage } from '../supabase/functions/_backend/utils/posthog_queue.ts'
import { executeSQL, POSTGRES_URL } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 12 })
afterAll(() => pool.end())
async function fixture() {
  const key = `test:evaluation:${randomUUID()}`
  const client = await pool.connect()
  const store = new DispatchStore(client)
  return { key, store, client, cleanup: async () => {
    await executeSQL('DELETE FROM public.bento_event_dispatches WHERE flow_key = $1', [key])
    await executeSQL('DELETE FROM public.bento_evaluation_runs WHERE evaluation_key = $1', [key])
    client.release()
  } }
}
async function running(f: Awaited<ReturnType<typeof fixture>>) {
  const queued = (await f.store.schedule(f.key, 1))!
  await f.store.markEnqueued(queued.id, queued.enqueue_claim_token!)
  return (await f.store.claimRun({ version: 1, evaluationKey: f.key, runId: queued.id }))!
}
function selected(f: Awaited<ReturnType<typeof fixture>>, context = randomUUID()): EligibleUser {
  return { flowKey: f.key, contextKey: context, recipientKey: 'email:recipient@example.com', email: 'recipient@example.com', tag: 'test:reminder', action: 'send', reason: 'due', metadata: {} }
}

describe('bento evaluation PostgreSQL store', () => {
  it('enforces read-only transactions at PostgreSQL, including mutating functions and statements', async () => {
    const f = await fixture()
    try {
      expect(await f.store.readOnly(ctx => ctx.query('SHOW transaction_read_only'))).toEqual([{ transaction_read_only: 'on' }])
      await expect(f.store.readOnly(ctx => ctx.query('WITH inserted AS (INSERT INTO public.bento_evaluation_runs (evaluation_key, scheduled_for) VALUES ($1, NOW()) RETURNING id) SELECT id FROM inserted', [f.key]))).rejects.toMatchObject({ code: '25006' })
      expect(await f.store.readOnly(ctx => ctx.query('SELECT 1 AS value'))).toEqual([{ value: 1 }])
    }
    finally {
      await f.cleanup()
    }
  })

  it.each([1, 5])('schedules first work once, then observes the durable %i-minute cadence', async (minutes) => {
    const f = await fixture()
    try {
      const run = (await f.store.schedule(f.key, minutes))!
      expect(run.id).toBeTruthy()
      expect(await f.store.schedule(f.key, minutes)).toBeNull()
      await f.store.markEnqueued(run.id, run.enqueue_claim_token!)
      const claimed = (await f.store.claimRun({ version: 1, evaluationKey: f.key, runId: run.id }))!
      await f.store.completeRun(claimed, {})
      expect(await f.store.schedule(f.key, minutes)).toBeNull()
      await executeSQL(`UPDATE public.bento_evaluation_runs SET enqueued_at = NOW() - ($2 * INTERVAL '1 minute') - INTERVAL '1 second' WHERE id = $1`, [run.id, minutes])
      expect((await f.store.schedule(f.key, minutes))!.id).not.toBe(run.id)
    }
    finally {
      await f.cleanup()
    }
  })

  it('uses durable queue receipt for cadence after publication succeeds and its marker write is lost', async () => {
    const f = await fixture()
    try {
      const pending = (await f.store.schedule(f.key, 5))!
      // The queue received this job, but the publisher died before markEnqueued.
      const run = (await f.store.claimRun({ version: 1, evaluationKey: f.key, runId: pending.id }))!
      await f.store.completeRun(run, {})
      const [receipt] = await executeSQL<{ enqueued_at: Date | null }>('SELECT enqueued_at FROM public.bento_evaluation_runs WHERE id = $1', [run.id])
      expect(receipt!.enqueued_at).not.toBeNull()
      expect(await f.store.schedule(f.key, 5)).toBeNull()
      await executeSQL(`UPDATE public.bento_evaluation_runs SET enqueued_at = NOW() - INTERVAL '5 minutes 1 second' WHERE id = $1`, [run.id])
      expect((await f.store.schedule(f.key, 5))!.id).not.toBe(run.id)
    }
    finally { await f.cleanup() }
  })

  it('serializes overlapping cron calls and retries a publication crash with the same UUID', async () => {
    const f = await fixture()
    try {
      const scheduled = await Promise.all(Array.from({ length: 8 }, async () => {
        const client = await pool.connect()
        try {
          return await new DispatchStore(client).schedule(f.key, 1)
        }
        finally {
          client.release()
        }
      }))
      expect(scheduled.filter(Boolean)).toHaveLength(1)
      const first = scheduled.find(Boolean)!
      await executeSQL(`UPDATE public.bento_evaluation_runs SET enqueue_claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id])
      const retry = (await f.store.schedule(f.key, 1))!
      expect(retry.id).toBe(first.id)
      expect(retry.enqueue_claim_token).not.toBe(first.enqueue_claim_token)
      expect(await f.store.markEnqueued(first.id, first.enqueue_claim_token!)).toBe(false)
      expect(await f.store.markEnqueued(retry.id, retry.enqueue_claim_token!)).toBe(true)
    }
    finally {
      await f.cleanup()
    }
  })

  it('fences execution duplicates and old owners after a consumer crash', async () => {
    const f = await fixture()
    try {
      const first = await running(f)
      const job = { version: 1 as const, evaluationKey: f.key, runId: first.id }
      expect(await f.store.claimRun(job)).toBeNull()
      expect(await f.store.schedule(f.key, 1)).toBeNull()
      await executeSQL(`UPDATE public.bento_evaluation_runs SET execution_claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id])
      const replacement = (await f.store.claimRun(job))!
      expect(replacement.execution_claim_token).not.toBe(first.execution_claim_token)
      await expect(f.store.completeRun(first, {})).rejects.toThrow('Evaluation claim lost')
      await f.store.completeRun(replacement, {})
      expect(await f.store.claimRun(job)).toBeNull()
    }
    finally {
      await f.cleanup()
    }
  })

  it('persists selection and stable audit intents atomically, retries analytics without another event attempt', async () => {
    const f = await fixture()
    try {
      const run = await running(f)
      const user = selected(f)
      const audits = buildEligibilityAudit(run.id, f.key, [user])
      await f.store.saveSelection(run, [user], audits)
      const [saved] = await executeSQL<{ eligible_users: EligibleUser[], pending_audit: typeof audits }>('SELECT eligible_users, pending_audit FROM public.bento_evaluation_runs WHERE id = $1', [run.id])
      expect(saved!.eligible_users).toEqual([user])
      expect(saved!.pending_audit).toEqual(expect.arrayContaining(audits))
      const seen: string[] = []
      await expect(f.store.flushRunAudit(run.id, { send: async (event: any) => {
        seen.push(event.event_id)
        throw new Error('queue unavailable')
      } })).rejects.toThrow()
      await f.store.flushRunAudit(run.id, { send: async (event: any) => {
        seen.push(event.event_id)
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      } })
      expect(seen[0]).toBe(seen[1])
      await f.store.recordFlowEvent(run, user, 'flow:started', 'initial_provider_accepted')
      const claim = (await f.store.claimEvent(run, user))!
      expect(claim.attempt_count).toBe(1)
      await f.store.acceptEvent(run, claim, user)
      expect(await f.store.claimEvent(run, user)).toBeNull()
      await f.store.relayPendingAudit({ send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) })
      const [event] = await executeSQL<{ status: string, attempt_count: number, pending_audit: unknown[] }>('SELECT status, attempt_count, pending_audit FROM public.bento_event_dispatches WHERE id = $1', [claim.id])
      expect(event).toEqual({ status: 'accepted', attempt_count: 1, pending_audit: [] })
    }
    finally {
      await f.cleanup()
    }
  })

  it('records full deep and oversized external facts with a concise schema-valid audit reference', async () => {
    const f = await fixture()
    try {
      const run = await running(f)
      const user = { ...selected(f), metadata: {
        event_id: 'domain-history-reference',
        bento: 'domain-fact-label',
        nested: { child: { child: { child: { child: { child: { label: 'domain-value' } } } } } },
        large: '漢字'.repeat(100000),
      } }
      await f.store.recordFlowEvent(run, user, 'external:observed', 'external_fact_observed')
      const [fact] = await executeSQL<{ id: string, details: typeof user.metadata, pending_audit: unknown[] }>(`SELECT id, details, pending_audit
        FROM public.bento_event_dispatches WHERE flow_key = $1 AND context_key = $2 AND tag = 'external:observed'`, [f.key, user.contextKey])
      expect(fact!.details).toEqual(user.metadata)
      expect(fact!.pending_audit).toHaveLength(1)
      const audit = parsePostHogMessage(fact!.pending_audit[0])
      expect(audit).toBeDefined()
      expect(audit!.request_id).toBe(run.id)
      expect(audit!.payload.nonPersonTags).toMatchObject({
        dispatch_id: fact!.id,
        flow_key: user.flowKey,
        context_key: user.contextKey,
        recipient_key: user.recipientKey,
        tag: 'external:observed',
        reason: 'external_fact_observed',
      })
      expect(audit!.payload.nonPersonTags).not.toHaveProperty('metadata')
      expect(JSON.stringify(audit).length).toBeLessThan(2000)
    }
    finally { await f.cleanup() }
  })

  it('preserves the original handler selection across retries while sanitizing only analytics', async () => {
    const f = await fixture()
    try {
      const pending = (await f.store.schedule(f.key, 1))!
      await f.store.markEnqueued(pending.id, pending.enqueue_claim_token!)
      const user = { ...selected(f), metadata: { event_id: 'safe-domain-history', bento: 'safe-domain-label', nested: { child: { child: { child: { child: { child: { label: 'domain-value' } } } } } } } }
      const seen: EligibleUser[][] = []
      const reports: any[] = []
      const evaluation = {
        key: f.key,
        everyMinutes: 1,
        findEligibleUsers: async () => [user],
        handleEligibleUsers: async (_ctx: unknown, users: EligibleUser[]) => {
          seen.push(JSON.parse(JSON.stringify(users)))
          if (seen.length === 1)
            throw new Error('retry after handler crash')
          return { handled: users.length }
        },
      }
      const queue = { send: async (report: unknown) => {
        reports.push(report)
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
      } }
      const job = { version: 1 as const, evaluationKey: f.key, runId: pending.id }
      await expect(processDispatchJob(job, f.store, {} as never, evaluation, queue)).rejects.toThrow()
      await processDispatchJob(job, f.store, {} as never, evaluation, queue)
      expect(seen).toEqual([[user], [user]])
      const eligibility = reports.filter(report => report.payload.event === 'bento:evaluation_eligible')
      expect(eligibility.every(report => report.payload.nonPersonTags.encoding === 'json-fragment')).toBe(true)
      const safeUser = JSON.parse(eligibility.map(report => report.payload.nonPersonTags.eligible_user_json).join(''))
      expect(safeUser.metadata).toEqual({ nested: user.metadata.nested })
    }
    finally { await f.cleanup() }
  })

  it('caps logical event attempts at five and fences stale provider markers', async () => {
    const f = await fixture()
    try {
      const run = await running(f)
      const user = selected(f)
      await f.store.recordFlowEvent(run, user, 'flow:started', 'initial_provider_accepted')
      const first = (await f.store.claimEvent(run, user))!
      await executeSQL(`UPDATE public.bento_event_dispatches SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id])
      const second = (await f.store.claimEvent(run, user))!
      expect(await f.store.acceptEvent(run, first, user)).toBe(false)
      await f.store.failEvent(run, second, user, 'provider_rejected')
      for (let attempt = 3; attempt <= 5; attempt++) {
        await executeSQL(`UPDATE public.bento_event_dispatches SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id])
        const next = (await f.store.claimEvent(run, user))!
        expect(next.attempt_count).toBe(attempt)
        await f.store.failEvent(run, next, user, 'provider_timeout')
      }
      await executeSQL(`UPDATE public.bento_event_dispatches SET claim_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [first.id])
      expect(await f.store.claimEvent(run, user)).toBeNull()
    }
    finally {
      await f.cleanup()
    }
  })

  it('caps durable publication and execution attempts at five', async () => {
    const f = await fixture()
    try {
      let pending = (await f.store.schedule(f.key, 1))!
      const originalId = pending.id
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(pending.id).toBe(originalId)
        await f.store.publicationFailed(pending.id, pending.enqueue_claim_token!)
        if (attempt < 5)
          pending = (await f.store.schedule(f.key, 1))!
      }
      expect(await f.store.schedule(f.key, 1)).toBeNull()
      const [exhausted] = await executeSQL<{ status: string, enqueue_attempt_count: number }>('SELECT status, enqueue_attempt_count FROM public.bento_evaluation_runs WHERE id = $1', [originalId])
      expect(exhausted).toEqual({ status: 'failed', enqueue_attempt_count: 5 })
      await executeSQL('DELETE FROM public.bento_evaluation_runs WHERE id = $1', [originalId])
      let run = await running(f)
      const job = { version: 1 as const, evaluationKey: f.key, runId: run.id }
      for (let attempt = 1; attempt <= 5; attempt++) {
        await f.store.failRun(run, 'handler')
        if (attempt < 5)
          run = (await f.store.claimRun(job))!
      }
      expect(await f.store.claimRun(job)).toBeNull()
      const [executed] = await executeSQL<{ status: string, execution_attempt_count: number }>('SELECT status, execution_attempt_count FROM public.bento_evaluation_runs WHERE id = $1', [run.id])
      expect(executed).toEqual({ status: 'failed', execution_attempt_count: 5 })
    }
    finally { await f.cleanup() }
  })

  it('atomically closes an active start fact and records just one terminal reason with its audit', async () => {
    const f = await fixture()
    try {
      const run = await running(f)
      const user = selected(f)
      await f.store.recordFlowEvent(run, user, 'flow:started', 'initial_provider_accepted')
      await f.store.endFlow(run, user, 'removed')
      await f.store.endFlow(run, user, 'accepted')
      const rows = await executeSQL<{ tag: string, closed_at: unknown, details: { reason?: string }, pending_audit: unknown[] }>('SELECT tag, closed_at, details, pending_audit FROM public.bento_event_dispatches WHERE context_key = $1 ORDER BY tag', [user.contextKey])
      expect(rows).toHaveLength(2)
      expect(rows.find(row => row.tag === 'flow:started')!.closed_at).not.toBeNull()
      expect(rows.find(row => row.tag === 'flow:ended')!.details.reason).toBe('removed')
      expect(rows.find(row => row.tag === 'flow:ended')!.pending_audit).toHaveLength(1)
      expect(await f.store.claimEvent(run, user)).toBeNull()
    }
    finally {
      await f.cleanup()
    }
  })
})
