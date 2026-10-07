import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, sendTracking, cloudlog, checkPermission, broadcast, recordBento } = vi.hoisted(() => ({
  state: { actorId: 'actor-a' },
  sendTracking: vi.fn(),
  cloudlog: vi.fn(),
  checkPermission: vi.fn(),
  broadcast: vi.fn(),
  recordBento: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  parseBody: (c: Context) => c.req.json(),
  quickError: (status: number, error: string) => { throw new HTTPException(status as 400, { res: Response.json({ error }, { status }) }) },
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
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission }))
vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: sendTracking,
  addAuthenticatedApiKeyIdToTrackingPayload: (payload: unknown) => payload,
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseWithAuth: () => ({}) }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/realtime_broadcast.ts', () => ({ broadcastCLIEvent: broadcast }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: (_c: Context, promise: Promise<unknown>) => promise }))
vi.mock('../supabase/functions/_backend/utils/app_onboarding_login.ts', () => ({ markAppOnboardingLoginFromTracking: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/builder_onboarding_checklist.ts', () => ({ markBuilderChecklistFromAnalytics: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/user_bento_events.ts', () => ({ recordUserBentoEvent: recordBento }))
vi.mock('../supabase/functions/_backend/utils/onboarding_copy_tracking.ts', () => ({ buildAiInstructionsCopiedBentoEvent: () => undefined }))

const { app } = await import('../supabase/functions/_backend/private/events.ts')
const acceptedAt = Date.parse('2026-10-06T10:00:00Z')
const clientEventId = '031c6527-7d90-442d-9abd-17f442067e20'

async function request(overrides: Record<string, unknown> = {}) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer jwt-secret' },
    body: JSON.stringify({ channel: 'usage', event: 'Tracked Event', tracking_version: 2, ...overrides }),
  })
}

beforeEach(() => {
  state.actorId = 'actor-a'
  vi.spyOn(Date, 'now').mockReturnValue(acceptedAt)
  sendTracking.mockResolvedValue(undefined)
  checkPermission.mockResolvedValue(true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('/private/events acceptance', () => {
  it('accepts old clients without an ID and only adds event_id to the existing response', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string, event_id: string }
    expect(body).toEqual({ status: 'ok', event_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(sendTracking.mock.calls[0][1]).toMatchObject({ event_id: body.event_id, occurred_at: new Date(acceptedAt).toISOString(), accepted_at: new Date(acceptedAt).toISOString() })
    expect(recordBento).toHaveBeenCalledOnce()
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
  })

  it.each([null, 5, '', 'invalid'])('rejects a malformed supplied ID %s without delivery', async (client_event_id) => {
    expect((await request({ client_event_id })).status).toBe(400)
    expect(sendTracking).not.toHaveBeenCalled()
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
    expect(sendTracking).not.toHaveBeenCalled()
    expect(recordBento).not.toHaveBeenCalled()
  })
})
