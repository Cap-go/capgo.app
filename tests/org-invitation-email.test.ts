import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { executeSQL, POSTGRES_URL, USER_ID, USER_ID_NONMEMBER } from './test-utils.ts'

// Use Worker bindings in this Node test; database operations remain real.
vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => ({
  ...await vi.importActual('../supabase/functions/_backend/utils/utils.ts'),
  getEnv: (c: Context, key: string) => c.env[key] ?? '',
  existInEnv: (c: Context, key: string) => c.env[key] !== undefined,
}))

const { app } = await import('../cloudflare_workers/api/triggers/send_email.ts')
type Kind = 'new' | 'existing'

beforeAll(() => vi.stubGlobal('EdgeRuntime', undefined))
afterAll(() => vi.unstubAllGlobals())

async function createFixture(kind: Kind) {
  const orgId = randomUUID()
  const orgName = `Invitation delivery test ${orgId}`
  const generations: string[] = []
  await executeSQL(`
    INSERT INTO public.orgs (id, created_by, name, management_email)
    VALUES ($1, $2, $3, 'invitation-delivery@example.com')
  `, [orgId, USER_ID, orgName])
  const invitations = kind === 'new'
    ? await executeSQL<{ id: number }>(`
      INSERT INTO public.tmp_users (org_id, email, first_name, last_name, invite_magic_string, invited_by_user_id)
      VALUES ($1, $2, 'Alex', '', $3, $4) RETURNING id
    `, [orgId, `invitation-${orgId}@example.com`, `token-${orgId}`, USER_ID])
    : await executeSQL<{ id: number }>(`
      INSERT INTO public.org_users (org_id, user_id, is_invite, rbac_role_name)
      VALUES ($1, $2, true, 'org_member') RETURNING id
    `, [orgId, USER_ID_NONMEMBER])
  const inviteId = invitations[0]!.id
  const column = kind === 'new' ? 'tmp_user_id' : 'org_user_id'
  const state = async () => {
    const rows = await executeSQL<{ id: string, sent_at: string | null, message_id: string | null }>(`
      SELECT id, sent_at, message_id FROM public.org_invitation_email_requests WHERE ${column} = $1
    `, [inviteId])
    const row = rows[0]!
    if (row && !generations.includes(row.id))
      generations.push(row.id)
    return row
  }
  const send = vi.fn(async (_email: unknown) => ({ messageId: `message-${orgId}` }))
  const post = (id: string) => app.request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apisecret': 'invitation-test-secret' },
    body: JSON.stringify({ org_invitation_id: id }),
  }, {
    API_SECRET: 'invitation-test-secret',
    SUPABASE_DB_URL: POSTGRES_URL,
    WEBAPP_URL: 'https://console.capgo.app',
    AUTH_EMAIL: { send },
  } as never)
  await state()
  return {
    orgId,
    orgName,
    inviteId,
    column,
    state,
    send,
    post,
    cleanup: async () => {
      await executeSQL('DELETE FROM public.bento_event_dispatches WHERE context_key = ANY($1)', [generations])
      await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
      await executeSQL(`DELETE FROM pgmq.q_send_email WHERE message->'payload'->>'org_invitation_id' = ANY($1)`, [generations])
    },
  }
}

describe.each(['new', 'existing'] as const)('%s-account invitation delivery with PostgreSQL', (kind) => {
  it.concurrent('sends once across eight concurrent deliveries and records provider acceptance', async () => {
    const fixture = await createFixture(kind)
    try {
      const queued = await fixture.state()
      const responses = await Promise.all(Array.from({ length: 8 }, () => fixture.post(queued.id)))
      expect(responses.map(response => response.status)).toEqual(Array.from({ length: 8 }).fill(200))
      expect(fixture.send).toHaveBeenCalledOnce()
      const content = fixture.send.mock.calls[0]![0] as { subject: string, html: string, text: string }
      expect(content.subject).toBe(kind === 'new'
        ? `[Capgo]: Join ${fixture.orgName} org & create account`
        : `[Capgo]: Join ${fixture.orgName} with your account`)
      expect(content.text).toContain(kind === 'new'
        ? `/invitation?invite_magic_string=token-${fixture.orgId}`
        : `/dashboard?invite_org=${fixture.orgId}`)
      const sent = await fixture.state()
      expect(sent.sent_at).not.toBeNull()
      const facts = await executeSQL<{ tag: string, status: string, details: { kind: string, invitationId: number }, pending_audit: unknown[] }>(
        'SELECT tag, status, details, pending_audit FROM public.bento_event_dispatches WHERE context_key = $1',
        [sent.id],
      )
      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ tag: 'flow:started', status: 'recorded', details: { kind, invitationId: String(fixture.inviteId) } })
      expect(facts[0]!.pending_audit).toHaveLength(1)
      const [timing] = await executeSQL<{ exact: boolean }>(`SELECT d.event_at = r.sent_at AS exact
        FROM public.bento_event_dispatches d JOIN public.org_invitation_email_requests r ON r.id::text = d.context_key
        WHERE r.id = $1`, [sent.id])
      expect(timing!.exact).toBe(true)
      expect(JSON.stringify(facts)).not.toContain('invite_magic_string')
      expect(sent.message_id).toBe(`message-${fixture.orgId}`)
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('leaves failed sends retryable and records the next successful attempt', async () => {
    const fixture = await createFixture(kind)
    try {
      const queued = await fixture.state()
      fixture.send.mockRejectedValueOnce(new Error('test provider unavailable'))
      expect((await fixture.post(queued.id)).status).toBe(500)
      expect(await fixture.state()).toMatchObject({ id: queued.id, sent_at: null, message_id: null })
      expect((await fixture.post(queued.id)).status).toBe(200)
      expect(fixture.send).toHaveBeenCalledTimes(2)
      expect((await fixture.state()).message_id).toBe(`message-${fixture.orgId}`)
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('skips superseded jobs and invitations cancelled or accepted before sending', async () => {
    const fixture = await createFixture(kind)
    try {
      const queued = await fixture.state()
      await executeSQL(`
        UPDATE public.org_invitation_email_requests SET requested_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'
        WHERE id = $1
      `, [queued.id])
      if (kind === 'new') {
        await executeSQL('UPDATE public.tmp_users SET invite_magic_string = $2 WHERE id = $1', [fixture.inviteId, `rotated-${fixture.orgId}`])
      }
      else {
        await executeSQL(`SELECT public.queue_org_invitation_email('existing', $1, $2)`, [fixture.inviteId, USER_ID])
      }
      const replacement = await fixture.state()
      expect(replacement.id).not.toBe(queued.id)
      expect((await fixture.post(queued.id)).status).toBe(200)
      expect(fixture.send).not.toHaveBeenCalled()
      if (kind === 'new')
        await executeSQL('UPDATE public.tmp_users SET cancelled_at = CURRENT_TIMESTAMP WHERE id = $1', [fixture.inviteId])
      else
        await executeSQL('UPDATE public.org_users SET is_invite = false WHERE id = $1', [fixture.inviteId])
      expect((await fixture.post(replacement.id)).status).toBe(200)
      expect(fixture.send).not.toHaveBeenCalled()
      expect((await fixture.state()).sent_at).toBeNull()
    }
    finally {
      await fixture.cleanup()
    }
  })
})

it('records a delayed provider acceptance after the shared transaction idle cutoff', async () => {
  const fixture = await createFixture('new')
  try {
    fixture.send.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 16_000))
      return { messageId: 'delayed-message' }
    })
    const queued = await fixture.state()
    expect((await fixture.post(queued.id)).status).toBe(200)
    expect(await fixture.state()).toMatchObject({ id: queued.id, message_id: 'delayed-message' })
    expect((await fixture.state()).sent_at).not.toBeNull()
    expect((await fixture.post(queued.id)).status).toBe(200)
    expect(fixture.send).toHaveBeenCalledOnce()
  }
  finally {
    await fixture.cleanup()
  }
}, 25_000)
