import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  syncBentoFirstOrgOnRoleBindingWriteMock,
  syncBentoFirstOrgOnUserCreateMock,
  syncBentoSubscriberTagsMock,
  supabaseFromMock,
} = vi.hoisted(() => {
  const maybeSingle = vi.fn(async () => ({ data: { email: 'invitee@example.com' }, error: null }))
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return {
    syncBentoFirstOrgOnRoleBindingWriteMock: vi.fn(async () => undefined),
    syncBentoFirstOrgOnUserCreateMock: vi.fn(async () => undefined),
    syncBentoSubscriberTagsMock: vi.fn(async () => true),
    supabaseFromMock: { eq, from, maybeSingle, select },
  }
})

vi.mock('../supabase/functions/_backend/utils/bento_first_org.ts', () => ({
  syncBentoFirstOrgOnRoleBindingWrite: syncBentoFirstOrgOnRoleBindingWriteMock,
  syncBentoFirstOrgOnUserCreate: syncBentoFirstOrgOnUserCreateMock,
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/bento.ts')
  return {
    ...actual,
    syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/supabase.ts')
  return {
    ...actual,
    supabaseAdmin: () => ({ from: supabaseFromMock.from }),
  }
})

const apiWorker = (await import('../cloudflare_workers/api/index.ts')).default

const API_SECRET = 'test-secret'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const ROLE_BINDING_ID = '33333333-3333-4333-8333-333333333333'
const ROLE_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const originalApiSecret = process.env.API_SECRET

const roleBindingRecord = {
  app_id: null,
  bundle_id: null,
  channel_id: null,
  expires_at: null,
  granted_at: '2026-08-03T09:15:00.000Z',
  granted_by: USER_ID,
  id: ROLE_BINDING_ID,
  is_direct: true,
  org_id: ORG_ID,
  parent_binding_id: null,
  principal_id: USER_ID,
  principal_type: 'user',
  reason: 'Accepted invitation',
  role_id: ROLE_ID,
  scope_type: 'org',
}

function requestPayload(payload: unknown, apiSecret: string | null = API_SECRET) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-capgo-queue-max-reads': '5',
    'x-capgo-queue-name': 'on_user_org_access',
    'x-capgo-queue-read-count': '1',
  }
  if (apiSecret !== null)
    headers.apisecret = apiSecret

  return apiWorker.fetch(new Request('https://api.capgo.app/triggers/on_user_org_access', {
    body: JSON.stringify(payload),
    headers,
    method: 'POST',
  }))
}

function requestRoleBindingWrite(
  type: 'INSERT' | 'UPDATE',
  apiSecret: string | null = API_SECRET,
  record = roleBindingRecord,
) {
  return requestPayload({
    old_record: type === 'UPDATE' ? record : null,
    record,
    schema: 'public',
    table: 'role_bindings',
    type,
  }, apiSecret)
}

describe('first-organization lifecycle trigger route', () => {
  beforeEach(() => {
    process.env.API_SECRET = API_SECRET
    vi.clearAllMocks()
    syncBentoFirstOrgOnRoleBindingWriteMock.mockResolvedValue(undefined)
    syncBentoSubscriberTagsMock.mockResolvedValue(true)
    supabaseFromMock.maybeSingle.mockResolvedValue({ data: { email: 'invitee@example.com' }, error: null })
  })

  afterEach(() => {
    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
  })

  it.each(['INSERT', 'UPDATE'] as const)('dispatches authenticated %s payloads and returns JSON success', async (type) => {
    const response = await requestRoleBindingWrite(type)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).toHaveBeenCalledOnce()
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).toHaveBeenCalledWith(expect.anything(), ROLE_BINDING_ID)
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(expect.anything(), {
      deleteSegments: [],
      email: 'invitee@example.com',
      segments: ['org:invite_accepted'],
    })
  })

  it('skips invite-accepted tagging when reason is not Accepted invitation', async () => {
    const response = await requestRoleBindingWrite('INSERT', API_SECRET, {
      ...roleBindingRecord,
      reason: 'SSO org membership provisioning',
    })

    expect(response.status).toBe(200)
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('returns 5xx so the queue retries when lifecycle delivery fails', async () => {
    syncBentoFirstOrgOnRoleBindingWriteMock.mockRejectedValueOnce(new Error('Bento unavailable'))

    const response = await requestRoleBindingWrite('INSERT')

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(response.status).toBeLessThan(600)
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).toHaveBeenCalledOnce()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a missing API secret', null],
    ['an invalid API secret', 'wrong-secret'],
  ])('rejects %s before invoking the lifecycle helper', async (_label, apiSecret) => {
    const response = await requestRoleBindingWrite('INSERT', apiSecret)

    expect(response.status).toBe(400)
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'role_bindings'],
    ['a number', 42],
    ['a boolean', false],
  ])('rejects %s JSON payload with a controlled validation error', async (_label, payload) => {
    const response = await requestPayload(payload)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_payload',
    })
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a different table', 'table_not_match', { old_record: null, record: roleBindingRecord, schema: 'public', table: 'users', type: 'INSERT' }],
    ['a delete event', 'type_not_match', { old_record: null, record: roleBindingRecord, schema: 'public', table: 'role_bindings', type: 'DELETE' }],
    ['a missing record ID', 'invalid_payload', { old_record: null, record: {}, schema: 'public', table: 'role_bindings', type: 'INSERT' }],
    ['a malformed record ID', 'invalid_payload', { old_record: null, record: { ...roleBindingRecord, id: 'not-a-uuid' }, schema: 'public', table: 'role_bindings', type: 'UPDATE' }],
  ])('rejects %s with a controlled validation error', async (_label, error, payload) => {
    const response = await requestPayload(payload)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error })
    expect(syncBentoFirstOrgOnRoleBindingWriteMock).not.toHaveBeenCalled()
    expect(syncBentoSubscriberTagsMock).not.toHaveBeenCalled()
  })

  it('registers the same route in the Supabase trigger router', async () => {
    // Importing this deployment entry point evaluates Deno.serve and starts a
    // server, so verify its static wiring without executing the module.
    const source = await readFile(new URL('../supabase/functions/triggers/index.ts', import.meta.url), 'utf8')

    expect(source).toContain('appGlobal.route(\'/on_user_org_access\', on_user_org_access)')
  })
})
