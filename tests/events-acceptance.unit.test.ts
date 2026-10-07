import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, sendTracking, cloudlog, checkPermission, broadcast, recordBento, queueSend, from, markChecklist, markLogin } = vi.hoisted(() => ({
  state: { actorId: 'actor-a' },
  sendTracking: vi.fn(),
  cloudlog: vi.fn(),
  checkPermission: vi.fn(),
  broadcast: vi.fn(),
  recordBento: vi.fn(),
  queueSend: vi.fn(),
  from: vi.fn(),
  markChecklist: vi.fn(),
  markLogin: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  parseBody: (c: Context) => c.req.json(),
  quickError: (status: number, error: string, message: string, moreInfo: Record<string, unknown> = {}) => {
    throw new HTTPException(status as 400, { res: Response.json(Object.keys(moreInfo).length ? { error, message, moreInfo } : { error }, { status }) })
  },
  simpleError: () => { throw new HTTPException(400) },
  useCors: (_c: Context, next: () => Promise<void>) => next(),
}))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: Context, next: () => Promise<void>) => {
    c.set('requestId', 'request-id')
    c.set('auth', { userId: state.actorId, jwt: 'jwt-secret' })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog, cloudlogErr: cloudlog }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission }))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendTracking,
  addAuthenticatedApiKeyIdToTrackingPayload: (payload: unknown) => payload,
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseWithAuth: () => ({ from }) }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/realtime_broadcast.ts', () => ({ broadcastCLIEvent: broadcast }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: (_c: Context, promise: Promise<unknown>) => promise }))
vi.mock('../supabase/functions/_backend/utils/app_onboarding_login.ts', () => ({ markAppOnboardingLoginFromTracking: markLogin }))
vi.mock('../supabase/functions/_backend/utils/builder_onboarding_checklist.ts', () => ({ markBuilderChecklistFromAnalytics: markChecklist }))
vi.mock('../supabase/functions/_backend/utils/user_bento_events.ts', () => ({ recordUserBentoEvent: recordBento }))
vi.mock('../supabase/functions/_backend/utils/onboarding_copy_tracking.ts', () => ({ buildAiInstructionsCopiedBentoEvent: () => undefined }))

const { app } = await import('../supabase/functions/_backend/private/events.ts')
const acceptedAt = Date.parse('2026-10-06T10:00:00Z')
const clientEventId = '031c6527-7d90-442d-9abd-17f442067e20'

async function request(overrides: Record<string, unknown> = {}, env: Record<string, unknown> = { POSTHOG_QUEUE: { send: queueSend } }) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer jwt-secret', 'cf-connecting-ip': '192.0.2.1' },
    body: JSON.stringify({ channel: 'usage', event: 'Tracked Event', tracking_version: 2, ...overrides }),
  }, env)
}

beforeEach(() => {
  state.actorId = 'actor-a'
  vi.spyOn(Date, 'now').mockReturnValue(acceptedAt)
  queueSend.mockResolvedValue(undefined)
  from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: table === 'apps' ? { owner_org: 'org-a', name: 'Example app' } : { id: 'org-a', name: 'Example org' } }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    }
    return query
  })
  sendTracking.mockResolvedValue(undefined)
  checkPermission.mockResolvedValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('/private/events durable acceptance', () => {
  it('accepts old clients without an ID and only adds event_id to the existing response', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string, event_id: string }
    expect(body).toEqual({ status: 'ok', event_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(sendTracking.mock.calls[0][1]).toMatchObject({ event_id: body.event_id, occurred_at: new Date(acceptedAt).toISOString(), accepted_at: new Date(acceptedAt).toISOString() })
    expect(recordBento).toHaveBeenCalledOnce()
    expect(queueSend.mock.calls[0][0]).toMatchObject({ event_id: body.event_id, payload: { timestamp: new Date(acceptedAt).toISOString(), distinct_id: 'actor-a', ip: '192.0.2.1' } })
    expect(queueSend.mock.calls[0][1]).toEqual({ contentType: 'json' })
    expect(sendTracking.mock.calls[0][2]).toEqual({ posthog: false })
  })

  it('returns the same accepted event ID across retries, scoped to authenticated actor and authorized org', async () => {
    const payload = { client_event_id: clientEventId, org_id: 'org-a', user_id: 'spoofed-actor', timestamp: acceptedAt - 1000 }
    const first = await (await request(payload)).json() as { status: string, event_id: string } as { status: string, event_id: string }
    const retry = await (await request(payload)).json() as { status: string, event_id: string }
    state.actorId = 'actor-b'
    const otherActor = await (await request(payload)).json() as { status: string, event_id: string }
    state.actorId = 'actor-a'
    const otherOrg = await (await request({ ...payload, org_id: 'org-b' })).json() as { status: string, event_id: string }
    expect(retry.event_id).toBe(first.event_id)
    expect(new Set([first.event_id, otherActor.event_id, otherOrg.event_id]).size).toBe(3)
    expect(sendTracking.mock.calls[0][1]).toMatchObject({ event_id: first.event_id, user_id: 'actor-a', groups: { organization: 'org-a' }, occurred_at: new Date(acceptedAt - 1000).toISOString() })
  })

  it('supports legacy organization-as-user identity without trusting it as the actor', async () => {
    const payload = { tracking_version: 1, user_id: 'org-a', client_event_id: clientEventId }
    const first = await (await request(payload)).json() as { status: string, event_id: string } as { status: string, event_id: string }
    state.actorId = 'actor-b'
    const other = await (await request(payload)).json() as { status: string, event_id: string }
    expect(other.event_id).not.toBe(first.event_id)
    expect(checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.read', { orgId: 'org-a' })
  })

  it('rejects unauthorized org scope before accepting or delivering an event', async () => {
    checkPermission.mockResolvedValue(false)
    expect((await request({ org_id: 'forbidden-org', client_event_id: clientEventId })).status).toBe(403)
    expect(sendTracking).not.toHaveBeenCalled()
    expect(cloudlog).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
  })

  it.each([null, 5, '', 'invalid'])('rejects a malformed supplied ID %s without delivery', async (client_event_id) => {
    expect((await request({ client_event_id })).status).toBe(400)
    expect(sendTracking).not.toHaveBeenCalled()
    expect(queueSend).not.toHaveBeenCalled()
  })

  it('freezes timing before background delivery and ignores forged canonical metadata', async () => {
    sendTracking.mockImplementation(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(acceptedAt + 10000)
    })
    const response = await request({ timestamp: acceptedAt + 86400_000, event_id: 'forged', occurred_at: 'forged', accepted_at: 'forged' })
    expect(response.status).toBe(200)
    expect(sendTracking.mock.calls[0][1]).toMatchObject({ timestamp: acceptedAt, occurred_at: new Date(acceptedAt).toISOString(), accepted_at: new Date(acceptedAt).toISOString() })
    expect(cloudlog).toHaveBeenCalledWith(expect.objectContaining({ message: 'tracking_event_accepted', duration_ms: 10000, timestamp_source: 'clamped' }))
  })

  it('keeps delivery details internal and logs acceptance without sensitive payload fields', async () => {
    const response = await request({
      org_id: 'org-a',
      client_event_id: clientEventId,
      event: 'customer-secret@example.com',
      description: 'private-description',
      tags: { email: 'customer-secret@example.com', jwt: 'jwt-secret', arbitrary: 'full-tags-secret' },
      nonPersonTags: { email: 'customer-secret@example.com' },
    })
    expect(await response.json()).toEqual({ status: 'ok', event_id: expect.any(String) })
    const acceptance = cloudlog.mock.calls.find(([log]) => log.message === 'tracking_event_accepted')?.[0]
    expect(acceptance).toEqual({
      requestId: 'request-id',
      message: 'tracking_event_accepted',
      event_id: expect.any(String),
      occurred_at: new Date(acceptedAt).toISOString(),
      accepted_at: new Date(acceptedAt).toISOString(),
      id_source: 'client',
      timestamp_source: 'server',
      duration_ms: 0,
    })
    for (const sensitive of ['@example.com', 'jwt-secret', 'private-description', 'full-tags-secret', 'actor-a', 'org-a'])
      expect(JSON.stringify(cloudlog.mock.calls)).not.toContain(sensitive)
  })

  it('retains the console-only delivery path and includes the accepted ID', async () => {
    const response = await request({ org_id: 'org-a', notifyConsole: true, client_event_id: clientEventId })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', event_id: expect.any(String) })
    expect(broadcast).toHaveBeenCalledOnce()
    expect(queueSend).not.toHaveBeenCalled()
    expect(sendTracking).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
  })
})

describe('queue persistence boundary', () => {
  it('awaits enqueue after authorization and before Bento enrichment or state writes', async () => {
    let persist!: () => void
    queueSend.mockImplementation(() => new Promise<void>((resolve) => {
      persist = resolve
    }))
    const response = request({ event: 'onboarding-step-done', org_id: 'org-a', tags: { app_id: 'com.example.queue' } })
    await vi.waitFor(() => expect(queueSend).toHaveBeenCalledOnce())
    expect(checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.read', { appId: 'com.example.queue' })
    expect(from.mock.calls.map(([table]) => table)).toEqual(['apps'])
    expect(sendTracking).not.toHaveBeenCalled()
    expect(markChecklist).not.toHaveBeenCalled()
    expect(markLogin).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
    persist()
    expect((await response).status).toBe(200)
    expect(from.mock.calls.length).toBeGreaterThan(1)
    expect(sendTracking).toHaveBeenCalledWith(expect.anything(), expect.anything(), { posthog: false })
  })

  it.each(['missing', 'failed'])('fails closed when the queue is %s without later side effects', async (mode) => {
    queueSend.mockRejectedValue(new Error('secret queue error'))
    const response = await request({ org_id: 'org-a', event: 'onboarding-step-done' }, mode === 'missing' ? {} : undefined)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'event_queue_unavailable' })
    expect(sendTracking).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(markChecklist).not.toHaveBeenCalled()
    expect(markLogin).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
    expect(JSON.stringify(cloudlog.mock.calls)).not.toContain('secret queue error')
  })

  it('returns 413 for an encoded UTF-8 snapshot over the safe size limit', async () => {
    const response = await request({ description: '雪'.repeat(35 * 1024) })
    expect(response.status).toBe(413)
    expect(queueSend).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(sendTracking).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
  })

  it.each([{ event: 4 }, { tags: 'invalid' }, { nonPersonTags: { depth: [[[[[[[[[[1]]]]]]]]]] } }])('rejects invalid provider payloads before any side effects', async (payload) => {
    expect((await request(payload)).status).toBe(400)
    expect(queueSend).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
  })

  it('excludes auth, raw body, Bento and caller group overrides from the provider snapshot', async () => {
    const response = await request({
      org_id: 'org-a',
      user_id: 'spoofed-actor',
      groups: { organization: 'forged-org' },
      bento: { secret: 'bento-secret' },
      jwt: 'body-jwt',
      token: 'capgo-secret',
      tags: { authorization: 'jwt-secret', $groups: { organization: 'forged-org' }, keep: 'safe' },
      nonPersonTags: { nested: { api_key: 'key-secret', jwt: 'tag-jwt', values: [{ token: 'nested-token', keep: true }] } },
    })
    expect(response.status).toBe(200)
    const snapshot = queueSend.mock.calls[0][0]
    expect(snapshot).toMatchObject({ source: 'private_events', payload: { distinct_id: 'actor-a', groups: { organization: 'org-a' }, tags: { keep: 'safe' } } })
    const encoded = JSON.stringify(snapshot)
    for (const secret of ['jwt-secret', 'body-jwt', 'capgo-secret', 'bento-secret', 'key-secret', 'tag-jwt', 'nested-token', 'forged-org', 'spoofed-actor'])
      expect(encoded).not.toContain(secret)
    expect(snapshot.payload.nonPersonTags).toEqual({ nested: { values: [{ keep: true }] } })
    expect(Object.keys(snapshot)).toEqual(['version', 'source', 'event_id', 'accepted_at', 'request_id', 'payload'])
  })

  it('keeps the accepted snapshot independent of later tracking mutations', async () => {
    sendTracking.mockImplementation(async (_c, payload) => {
      payload.tags.keep = 'changed'
      payload.nonPersonTags.nested.keep = 'changed'
    })
    expect((await request({ tags: { keep: 'original' }, nonPersonTags: { nested: { keep: 'original' } } })).status).toBe(200)
    expect(queueSend.mock.calls[0][0].payload.tags.keep).toBe('original')
    expect(queueSend.mock.calls[0][0].payload.nonPersonTags.nested.keep).toBe('original')
  })

  it.each([undefined, clientEventId])('preserves the original retry identity when the derived enqueue fails (client ID: %s)', async (client_event_id) => {
    queueSend.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('derived queue unavailable'))
    const payload = { event: 'Bundle Incompatible', org_id: 'org-a', client_event_id, tags: { app_id: 'com.example.queue', channel_overwritten: true, incompatibility_accepted: true } }
    const response = await request(payload)
    expect(response.status).toBe(503)
    const failure = await response.json() as { error: string, message: string, moreInfo: { client_event_id: string, event_id: string, timestamp: number, primary_event_queued: boolean, derived_event_queued: boolean } }
    const primary = queueSend.mock.calls[0][0]
    const derived = queueSend.mock.calls[1][0]
    expect(failure).toEqual({
      error: 'event_queue_unavailable',
      message: 'Primary event was queued but the derived event was not; retry with this client_event_id and timestamp',
      moreInfo: { client_event_id: client_event_id ?? expect.stringMatching(/^[0-9a-f-]{36}$/), event_id: primary.event_id, timestamp: acceptedAt, primary_event_queued: true, derived_event_queued: false },
    })
    expect(failure.moreInfo.client_event_id).not.toBe(primary.event_id)
    expect(sendTracking).not.toHaveBeenCalled()
    expect(markChecklist).not.toHaveBeenCalled()
    expect(markLogin).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
    vi.spyOn(Date, 'now').mockReturnValue(acceptedAt + 10000)
    const retry = await request({ ...payload, client_event_id: failure.moreInfo.client_event_id, timestamp: failure.moreInfo.timestamp })
    expect(retry.status).toBe(200)
    expect(queueSend.mock.calls[2][0]).toMatchObject({ event_id: primary.event_id, payload: { timestamp: primary.payload.timestamp } })
    expect(queueSend.mock.calls[3][0]).toMatchObject({ event_id: derived.event_id, payload: { timestamp: derived.payload.timestamp } })
  })

  it('queues the existing derived email outcome with stable identity and the same frozen time', async () => {
    const payload = { event: 'Bundle Incompatible', org_id: 'org-a', client_event_id: clientEventId, tags: { app_id: 'com.example.queue', channel_overwritten: true, incompatibility_accepted: true } }
    expect((await request(payload)).status).toBe(200)
    expect(queueSend).toHaveBeenCalledTimes(2)
    const first = queueSend.mock.calls[0][0]
    const derived = queueSend.mock.calls[1][0]
    expect(derived.event_id).not.toBe(first.event_id)
    expect(derived.payload).toMatchObject({ event: 'Bundle Incompatible Email', timestamp: first.payload.timestamp, setPersonProperties: false })
    expect((await request(payload)).status).toBe(200)
    expect(queueSend.mock.calls[3][0].event_id).toBe(derived.event_id)
  })
})
