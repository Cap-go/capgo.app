import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { findInvitationUsers, invitationEvaluation, resolveInvitation } from '../cloudflare_workers/bento_dispatch/flows/invitations.ts'
import { createMutationContext } from '../cloudflare_workers/bento_dispatch/helpers.ts'
import { DispatchStore } from '../cloudflare_workers/bento_dispatch/store.ts'
import { recordFlowEvent } from '../supabase/functions/_backend/utils/bento_flow_audit.ts'
import { executeSQL, POSTGRES_URL, USER_ID, USER_ID_NONMEMBER } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 12 })
afterAll(() => pool.end())
async function fixture(kind: 'new' | 'existing', tokenAge = '3 days') {
  const orgId = randomUUID()
  const email = `invitation-evaluation-${orgId}@example.com`
  await executeSQL(`INSERT INTO public.orgs (id, created_by, name, management_email) VALUES ($1::uuid, $2, 'Evaluation <Team> ' || $1::text, $3)`, [orgId, USER_ID, email])
  const [source] = kind === 'new'
    ? await executeSQL<{ id: number }>(`INSERT INTO public.tmp_users (org_id, email, first_name, last_name, invite_magic_string, invited_by_user_id, created_at, updated_at)
      VALUES ($1, $2, 'Test', '', $3, $4, NOW() - $5::interval, NOW() - $5::interval) RETURNING id`, [orgId, email, `test-token-${orgId}`, USER_ID, tokenAge])
    : await executeSQL<{ id: number }>(`INSERT INTO public.org_users (org_id, user_id, is_invite, rbac_role_name) VALUES ($1, $2, true, 'org_member') RETURNING id`, [orgId, USER_ID_NONMEMBER])
  const [request] = await executeSQL<{ id: string, email: string, token_at: string | null }>(`SELECT r.id, COALESCE(t.email, u.email) AS email, GREATEST(t.created_at, t.updated_at)::text AS token_at
    FROM public.org_invitation_email_requests r LEFT JOIN public.tmp_users t ON t.id = r.tmp_user_id
    LEFT JOIN public.org_users ou ON ou.id = r.org_user_id LEFT JOIN public.users u ON u.id = ou.user_id
    WHERE ${kind === 'new' ? 'r.tmp_user_id' : 'r.org_user_id'} = $1`, [source!.id])
  const client = await pool.connect()
  const store = new DispatchStore(client)
  const key = `test:invitation-eval:${orgId}`
  const scheduled = (await store.schedule(key, 1))!
  await store.markEnqueued(scheduled.id, scheduled.enqueue_claim_token!)
  const run = (await store.claimRun({ version: 1, evaluationKey: key, runId: scheduled.id }))!
  const details = { kind, orgId, invitationId: source!.id, userId: kind === 'existing' ? USER_ID_NONMEMBER : null, generation: request!.id, tokenCreatedAt: request!.token_at }
  await executeSQL(`UPDATE public.org_invitation_email_requests SET sent_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [request!.id])
  await recordFlowEvent(client, { flowKey: 'org:invitation', contextKey: request!.id, recipientKey: kind === 'new' ? `email:${email}` : `user:${USER_ID_NONMEMBER}`, email: request!.email, tag: 'flow:started', reason: 'initial_provider_accepted', details, eventAt: new Date(Date.now() - 3 * 86400000).toISOString() })
  const [start] = await executeSQL<{ id: string }>(`SELECT id FROM public.bento_event_dispatches WHERE context_key = $1 AND tag = 'flow:started'`, [request!.id])
  const find = (stage: 1 | 2) => store.readOnly(ctx => findInvitationUsers(ctx, kind, stage, start!.id))
  const markReminder = async (stage: 1 | 2, age: string) => executeSQL(`INSERT INTO public.bento_event_dispatches (flow_key, context_key, recipient_key, email, tag, status, event_at)
    SELECT flow_key, context_key, recipient_key, email, $2, 'accepted', NOW() - $3::interval FROM public.bento_event_dispatches WHERE id = $1`, [start!.id, `org:invite_${kind}_user_reminder_${stage}`, age])
  return { orgId, email, kind, sourceId: source!.id, requestId: request!.id, store, run, client, find, markReminder, cleanup: async () => {
    try {
      await executeSQL(`DELETE FROM public.bento_event_dispatches WHERE details->>'orgId' = $1 OR context_key = $2`, [orgId, request!.id])
      await executeSQL('DELETE FROM public.bento_evaluation_runs WHERE evaluation_key = $1', [key])
      await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
      await executeSQL(`DELETE FROM pgmq.q_send_email WHERE message->'payload'->>'org_invitation_id' = $1`, [request!.id])
    }
    finally {
      client.release()
    }
  } }
}

describe.each(['new', 'existing'] as const)('%s invitation evaluations', (kind) => {
  it('selects the complete live cohort after two days, requires first acceptance for the final reminder, and never snapshots tokens', async () => {
    const f = await fixture(kind)
    try {
      const [first] = await f.find(1)
      expect(first).toMatchObject({ action: 'send', reason: 'first_reminder_due', contextKey: f.requestId, metadata: { waitCondition: 'initial_acceptance_plus_2_days', waitSatisfied: true } })
      expect(new Date(String(first!.metadata.eligibleAt)).getTime() - new Date(String(first!.metadata.initialSentAt)).getTime()).toBe(2 * 86400000)
      expect(new Date(String(first!.metadata.evaluatedAt)).getTime()).toBeGreaterThanOrEqual(new Date(String(first!.metadata.eligibleAt)).getTime())
      expect(first!.metadata.firstReminderAcceptedAt).toBeNull()
      expect(first!.metadata.invitationExpiresAt === null).toBe(kind === 'existing')
      expect(JSON.stringify(first)).not.toContain('test-token')
      expect(await f.find(2)).toEqual([])
      await f.markReminder(1, '1 day')
      expect(await f.find(1)).toEqual([])
      expect(await f.find(2)).toEqual([])
      if (kind === 'existing') {
        await executeSQL(`UPDATE public.bento_event_dispatches SET event_at = NOW() - INTERVAL '5 days 1 second' WHERE context_key = $1 AND tag LIKE '%reminder_1'`, [f.requestId])
      }

      if (kind === 'existing')
        expect((await f.find(2))[0]).toMatchObject({ action: 'send', reason: 'final_reminder_due' })
    }
    finally {
      await f.cleanup()
    }
  })

  it('sends the fifth logical attempt and completes final reminders locally with audited termination', async () => {
    const f = await fixture(kind, '6 days 23 hours 1 minute')
    try {
      await f.markReminder(1, '6 days')
      const [user] = await f.find(2)
      expect(user!.metadata.firstReminderAcceptedAt).not.toBeNull()
      expect(user!.metadata.waitSatisfied).toBe(true)
      if (kind === 'new') {
        expect(user!.metadata.waitCondition).toBe('first_reminder_accepted_and_expiry_minus_1_hour')
        expect(new Date(String(user!.metadata.invitationExpiresAt)).getTime() - new Date(String(user!.metadata.eligibleAt)).getTime()).toBe(3600000)
        expect(new Date(String(user!.metadata.invitationExpiresAt)).getTime()).toBeGreaterThan(new Date(String(user!.metadata.evaluatedAt)).getTime())
      }
      else {
        expect(user!.metadata.waitCondition).toBe('first_reminder_acceptance_plus_5_days')
        expect(new Date(String(user!.metadata.eligibleAt)).getTime() - new Date(String(user!.metadata.firstReminderAcceptedAt)).getTime()).toBe(5 * 86400000)
      }
      await executeSQL(`INSERT INTO public.bento_event_dispatches (flow_key, context_key, recipient_key, email, tag, status, attempt_count)
        VALUES ($1, $2, $3, $4, $5, 'failed', 4)`, [user!.flowKey, user!.contextKey, user!.recipientKey, user!.email, user!.tag])
      let sends = 0
      const ctx = createMutationContext(f.store, f.run, async (event) => {
        sends++
        expect(event.data).toHaveProperty('invite_link')
        return true
      }, { WEBAPP_URL: 'https://console.example.com' }, Date.now, { send: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }) })
      expect(await invitationEvaluation(kind, 2).handleEligibleUsers(ctx, [user!])).toMatchObject({ accepted: 1 })
      expect(sends).toBe(1)
      const [accepted] = await executeSQL<{ attempt_count: number, status: string }>('SELECT attempt_count, status FROM public.bento_event_dispatches WHERE context_key = $1 AND tag = $2', [f.requestId, user!.tag])
      expect(accepted).toEqual({ attempt_count: 5, status: 'accepted' })
      const [ended] = await executeSQL<{ details: { reason: string } }>(`SELECT details FROM public.bento_event_dispatches WHERE context_key = $1 AND tag = 'flow:ended'`, [f.requestId])
      expect(ended!.details.reason).toBe('completed')
      expect(await f.find(2)).toEqual([])
    }
    finally {
      await f.cleanup()
    }
  })

  it('rechecks a saved candidate after resend and suppresses the obsolete generation', async () => {
    const f = await fixture(kind)
    try {
      const [user] = await f.find(1)
      await executeSQL(`UPDATE public.org_invitation_email_requests SET requested_at = NOW() - INTERVAL '6 minutes' WHERE id = $1`, [f.requestId])
      await executeSQL('SELECT public.queue_org_invitation_email($1, $2, $3)', [kind, f.sourceId, USER_ID])
      const action = await f.store.readOnly(ctx => resolveInvitation(ctx, user!, kind, 1, 'https://console.example.com'))
      expect(action).toEqual({ action: 'end', reason: 'superseded' })
      let sends = 0
      const ctx = createMutationContext(f.store, f.run, async () => {
        sends++
        return true
      })
      expect(await ctx.sendBentoEvent(user!, read => resolveInvitation(read, user!, kind, 1, 'https://console.example.com'))).toMatchObject({ outcome: 'ended' })
      expect(sends).toBe(0)
    }
    finally {
      await f.cleanup()
    }
  })

  it('distinguishes accepted membership from deleted source without membership', async () => {
    const f = await fixture(kind)
    try {
      if (kind === 'new')
        await executeSQL('DELETE FROM public.tmp_users WHERE id = $1', [f.sourceId])
      else
        await executeSQL('DELETE FROM public.org_users WHERE id = $1', [f.sourceId])
      expect((await f.find(1))[0]).toMatchObject({ action: 'end', reason: 'removed' })
      if (kind === 'existing') {
        await executeSQL(`INSERT INTO public.org_users (org_id, user_id, is_invite, rbac_role_name) VALUES ($1, $2, false, 'org_member')`, [f.orgId, USER_ID_NONMEMBER])
        expect((await f.find(1))[0]).toMatchObject({ action: 'end', reason: 'accepted' })
      }
    }
    finally {
      await f.cleanup()
    }
  })
})

it('distinguishes cancellation, token rotation and expiry for new-user flows', async () => {
  const f = await fixture('new')
  try {
    await executeSQL('UPDATE public.tmp_users SET cancelled_at = NOW() WHERE id = $1', [f.sourceId])
    expect((await f.find(1))[0]!.reason).toBe('cancelled')
    await executeSQL(`UPDATE public.tmp_users SET cancelled_at = NULL, updated_at = NOW() WHERE id = $1`, [f.sourceId])
    expect((await f.find(1))[0]!.reason).toBe('superseded')
  }
  finally {
    await f.cleanup()
  }
})

it('detects expired new-user tokens from their original source timestamp', async () => {
  const f = await fixture('new', '8 days')
  try {
    expect((await f.find(1))[0]!.reason).toBe('expired')
  }
  finally { await f.cleanup() }
})

it('evaluates every active invitation in the relevant cohort without recipient divisions', async () => {
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
  try {
    for (let i = 0; i < 7; i++)
      fixtures.push(await fixture('new'))
    const selected = await fixtures[0]!.store.readOnly(ctx => findInvitationUsers(ctx, 'new', 1))
    const own = selected.filter(user => fixtures.some(f => f.requestId === user.contextKey))
    expect(new Set(own.map(user => user.contextKey))).toEqual(new Set(fixtures.map(f => f.requestId)))
    expect(own.every(user => user.action === 'send')).toBe(true)
  }
  finally {
    for (const f of fixtures)
      await f.cleanup()
  }
})

it('uses actual new-account membership evidence after the temporary invitation disappears', async () => {
  const f = await fixture('new')
  const userId = randomUUID()
  try {
    await executeSQL('DELETE FROM public.tmp_users WHERE id = $1', [f.sourceId])
    expect((await f.find(1))[0]!.reason).toBe('removed')
    await executeSQL('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, f.email])
    await executeSQL('INSERT INTO public.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, f.email])
    await executeSQL(`INSERT INTO public.org_users (org_id, user_id, is_invite, rbac_role_name) VALUES ($1, $2, false, 'org_member')`, [f.orgId, userId])
    expect((await f.find(1))[0]!.reason).toBe('accepted')
  }
  finally {
    await f.cleanup()
    await executeSQL('DELETE FROM auth.users WHERE id = $1', [userId])
  }
})
