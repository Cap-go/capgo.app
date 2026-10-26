import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { executeSQL, POSTGRES_URL, USER_ID } from './test-utils.ts'

// Use Worker bindings in this Node test; database operations remain real.
vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => ({
  ...await vi.importActual('../supabase/functions/_backend/utils/utils.ts'),
  getEnv: (c: Context, key: string) => c.env[key] ?? '',
  existInEnv: (c: Context, key: string) => c.env[key] !== undefined,
}))

const { app } = await import('../cloudflare_workers/api/triggers/send_email.ts')
type Kind = 'new' | 'existing'
interface BentoEvent { type: string, email: string, details?: Record<string, string>, fields?: Record<string, string> }

// Record Bento batch events instead of calling the real API.
const bentoEvents: BentoEvent[] = []
const bentoHooks = new Map<string, () => Promise<void>>()
const realFetch = globalThis.fetch
beforeAll(() => {
  vi.stubGlobal('EdgeRuntime', undefined)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://app.bentonow.com/'))
      return realFetch(input, init)
    const { events } = JSON.parse(String(init?.body)) as { events: BentoEvent[] }
    bentoEvents.push(...events)
    for (const event of events) {
      const hook = event.details?.invite_id && bentoHooks.get(event.details.invite_id)
      if (hook)
        await hook()
    }
    return Response.json({ results: events.length, failed: 0 })
  })
})
afterAll(() => vi.unstubAllGlobals())

async function createFixture(kind: Kind, recipientEmail?: string) {
  const orgId = randomUUID()
  const orgName = `Invitation delivery test ${orgId}`
  const generations: string[] = []
  const recipientUserId = randomUUID()
  const email = recipientEmail ?? `invitation-${orgId}@example.com`
  if (kind === 'existing') {
    await executeSQL('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [recipientUserId, email])
    await executeSQL('INSERT INTO public.users (id, email) VALUES ($1, $2)', [recipientUserId, email])
  }
  await executeSQL(`
    INSERT INTO public.orgs (id, created_by, name, management_email)
    VALUES ($1, $2, $3, 'invitation-delivery@example.com')
  `, [orgId, USER_ID, orgName])
  const invitations = kind === 'new'
    ? await executeSQL<{ id: number }>(`
      INSERT INTO public.tmp_users (org_id, email, first_name, last_name, invite_magic_string, invited_by_user_id)
      VALUES ($1, $2, 'Alex', '', $3, $4) RETURNING id
    `, [orgId, email, `token-${orgId}`, USER_ID])
    : await executeSQL<{ id: number }>(`
      INSERT INTO public.org_users (org_id, user_id, is_invite, rbac_role_name)
      VALUES ($1, $2, true, 'org_member') RETURNING id
    `, [orgId, recipientUserId])
  const inviteId = invitations[0]!.id
  const column = kind === 'new' ? 'tmp_user_id' : 'org_user_id'
  const state = async () => {
    const rows = await executeSQL<{ id: string, sent_at: string | null, message_id: string | null, bento_synced_at: string | null, bento_email: string | null }>(`
      SELECT id, sent_at, message_id, bento_synced_at, bento_email FROM public.org_invitation_email_requests WHERE ${column} = $1
    `, [inviteId])
    const row = rows[0]!
    if (row && !generations.includes(row.id))
      generations.push(row.id)
    return row
  }
  const send = vi.fn(async (_email: unknown) => ({ messageId: `message-${orgId}` }))
  const request = (body: unknown) => app.request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apisecret': 'invitation-test-secret' },
    body: JSON.stringify(body),
  }, {
    API_SECRET: 'invitation-test-secret',
    SUPABASE_DB_URL: POSTGRES_URL,
    WEBAPP_URL: 'https://console.capgo.app',
    AUTH_EMAIL: { send },
    BENTO_PUBLISHABLE_KEY: 'invitation-test-publishable',
    BENTO_SECRET_KEY: 'invitation-test-secret',
    BENTO_SITE_UUID: 'invitation-test-site',
  } as never)
  const inviteSentEvents = () => bentoEvents.filter(event => event.type === 'org:invite_sent' && event.details?.org_id === orgId)
  await state()
  return {
    orgId,
    orgName,
    email,
    recipientUserId,
    inviteId,
    column,
    state,
    send,
    post: (id: string) => request({ org_invitation_id: id }),
    sync: () => request({ org_invitation_bento_sync: { email } }),
    inviteSentEvents,
    cleanup: async () => {
      await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
      if (kind === 'existing') {
        await executeSQL('DELETE FROM public.users WHERE id = $1', [recipientUserId])
        await executeSQL('DELETE FROM auth.users WHERE id = $1', [recipientUserId])
      }
      await executeSQL(`DELETE FROM pgmq.q_send_email WHERE message->'payload'->>'org_invitation_id' = ANY($1)`, [generations])
      await executeSQL(`DELETE FROM pgmq.q_send_email WHERE message->'payload'->'org_invitation_bento_sync'->>'email' = $1`, [email.trim().toLowerCase()])
      for (const id of generations)
        bentoHooks.delete(id)
    },
  }
}

describe.each(['new', 'existing'] as const)('%s-account invitation delivery with PostgreSQL', (kind) => {
  it.concurrent('reconciles a close after Bento acceptance with a lost response', async () => {
    const fixture = await createFixture(kind)
    try {
      const queued = await fixture.state()
      bentoHooks.set(queued.id, async () => { throw new Error('test response lost after acceptance') })
      expect((await fixture.post(queued.id)).status).toBe(500)
      expect(await fixture.state()).toMatchObject({ bento_email: fixture.email, bento_synced_at: null })
      expect(fixture.inviteSentEvents()).toHaveLength(1)
      await executeSQL(kind === 'new'
        ? 'DELETE FROM public.tmp_users WHERE id = $1'
        : 'UPDATE public.org_users SET is_invite = false WHERE id = $1', [fixture.inviteId])
      const jobs = await executeSQL<{ count: string }>(`
        SELECT count(*) FROM pgmq.q_send_email
        WHERE message->'payload'->'org_invitation_bento_sync'->>'email' = $1
      `, [fixture.email])
      expect(jobs[0]!.count).toBe('1')
      expect((await fixture.sync()).status).toBe(200)
      expect(bentoEvents.filter(event => event.type === '$update_fields' && event.email === fixture.email).at(-1)?.fields)
        .toEqual({ capgo_open_invites: '' })
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent.each(['accept', 'revoke'])('closes %s without waiting for Bento enrollment', async (action) => {
    const fixture = await createFixture(kind)
    const closePool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
    const closeSql = {
      new: action === 'accept'
        ? 'DELETE FROM public.tmp_users WHERE id = $1'
        : 'UPDATE public.tmp_users SET cancelled_at = CURRENT_TIMESTAMP WHERE id = $1',
      existing: action === 'accept'
        ? 'UPDATE public.org_users SET is_invite = false WHERE id = $1'
        : 'DELETE FROM public.org_users WHERE id = $1',
    }[kind]
    let releaseBento!: () => void
    let enteredBento!: () => void
    const entered = new Promise<void>((resolve) => { enteredBento = resolve })
    const released = new Promise<void>((resolve) => { releaseBento = resolve })
    let sending: Promise<Response> | undefined
    let closing: Promise<unknown> | undefined
    try {
      const queued = await fixture.state()
      bentoHooks.set(queued.id, async () => {
        enteredBento()
        await released
      })
      sending = Promise.resolve(fixture.post(queued.id))
      await entered
      // The close must finish while Bento remains blocked. A statement
      // timeout makes retaining a network-held request lock fail this test.
      await closePool.query("SET statement_timeout = '1s'")
      closing = closePool.query(closeSql, [fixture.inviteId])
      await closing
      const jobs = await executeSQL<{ count: string }>(`
        SELECT count(*) FROM pgmq.q_send_email
        WHERE message->'payload'->'org_invitation_bento_sync'->>'email' = $1
      `, [fixture.email])
      expect(jobs[0]!.count).toBe('1')
      releaseBento()
      expect((await sending).status).toBe(200)
      expect((await fixture.sync()).status).toBe(200)
      expect(bentoEvents.filter(event => event.type === '$update_fields' && event.email === fixture.email).at(-1)?.fields)
        .toEqual({ capgo_open_invites: '' })
    }
    finally {
      releaseBento()
      await Promise.allSettled([sending, closing])
      await closePool.end()
      await fixture.cleanup()
    }
  })

  it.concurrent('sends once across eight concurrent deliveries and starts one Bento flow', async () => {
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
      expect(sent.bento_synced_at).not.toBeNull()
      expect(sent.message_id).toBe(`message-${fixture.orgId}`)
      const events = fixture.inviteSentEvents()
      expect(events).toHaveLength(1)
      expect(events[0]!.details).toMatchObject({ invite_id: sent.id, kind })
      expect(events[0]!.fields!.capgo_open_invites.split(' ')).toContain(sent.id)
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

it('clears the original Bento subscriber after an account email changes and the account is deleted', async () => {
  const fixture = await createFixture('existing')
  try {
    const queued = await fixture.state()
    expect((await fixture.post(queued.id)).status).toBe(200)
    await executeSQL('UPDATE public.users SET email = $2 WHERE id = $1', [fixture.recipientUserId, `changed-${fixture.orgId}@example.com`])
    await executeSQL('DELETE FROM public.users WHERE id = $1', [fixture.recipientUserId])
    const jobs = await executeSQL<{ count: string }>(`
      SELECT count(*) FROM pgmq.q_send_email
      WHERE message->'payload'->'org_invitation_bento_sync'->>'email' = $1
    `, [fixture.email])
    expect(jobs[0]!.count).toBe('1')
    expect((await fixture.sync()).status).toBe(200)
    expect(bentoEvents.filter(event => event.type === '$update_fields' && event.email === fixture.email).at(-1)?.fields)
      .toEqual({ capgo_open_invites: '' })
  }
  finally {
    await fixture.cleanup()
  }
})

it('keeps both invitation kinds in one normalized subscriber field across concurrent enrollment and close syncs', async () => {
  const email = `mixed-invitation-${randomUUID()}@example.com`
  const newFixture = await createFixture('new', email.toUpperCase())
  const existingFixture = await createFixture('existing', email)
  try {
    const newState = await newFixture.state()
    const existingState = await existingFixture.state()
    const responses = await Promise.all([newFixture.post(newState.id), existingFixture.post(existingState.id)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const enrollments = bentoEvents.filter(event => event.type === 'org:invite_sent' && event.email === email)
    expect(enrollments).toHaveLength(2)
    expect(enrollments.at(-1)!.fields!.capgo_open_invites.split(' ').sort())
      .toEqual([newState.id, existingState.id].sort())
    await executeSQL('DELETE FROM public.tmp_users WHERE id = $1', [newFixture.inviteId])
    expect((await existingFixture.sync()).status).toBe(200)
    expect(bentoEvents.filter(event => event.type === '$update_fields' && event.email === email).at(-1)?.fields)
      .toEqual({ capgo_open_invites: existingState.id })
  }
  finally {
    await newFixture.cleanup()
    await existingFixture.cleanup()
  }
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
