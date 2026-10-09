import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trackBentoRecipientEventsMock, isBentoConfiguredMock, queryMock, closeClientMock } = vi.hoisted(() => ({
  trackBentoRecipientEventsMock: vi.fn(async () => true),
  isBentoConfiguredMock: vi.fn(() => true),
  queryMock: vi.fn(),
  closeClientMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/bento.ts')
  return {
    ...actual,
    isBentoConfigured: isBentoConfiguredMock,
    trackBentoRecipientEvents: trackBentoRecipientEventsMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/pg.ts')
  return {
    ...actual,
    getPgClient: () => ({ query: queryMock }),
    closeClient: closeClientMock,
  }
})

const apiWorker = (await import('../cloudflare_workers/api/index.ts')).default

const API_SECRET = 'test-secret'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const REMOVED_USER_ID = '11111111-1111-4111-8111-111111111111'
// Below every fixture member id, so the page models rows the cursor query can return.
const PAGE_CURSOR_USER_ID = '00000000-0000-4000-8000-000000000000'
const originalApiSecret = process.env.API_SECRET

function sendRevocation(record: unknown) {
  return apiWorker.fetch(new Request('https://api.capgo.app/triggers/on_shared_apikey_secret_revoked', {
    body: JSON.stringify({ type: 'UPDATE', table: 'apikeys', schema: 'public', old_record: null, record }),
    headers: {
      'content-type': 'application/json',
      'apisecret': API_SECRET,
      'x-capgo-queue-max-reads': '5',
      'x-capgo-queue-name': 'on_shared_apikey_secret_revoked',
      'x-capgo-queue-read-count': '1',
    },
    method: 'POST',
  }))
}

describe('on_shared_apikey_secret_revoked trigger', () => {
  beforeEach(() => {
    process.env.API_SECRET = API_SECRET
    trackBentoRecipientEventsMock.mockReset()
    trackBentoRecipientEventsMock.mockResolvedValue(true)
    isBentoConfiguredMock.mockReturnValue(true)
    queryMock.mockReset()
    closeClientMock.mockClear()
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM public.orgs'))
        return { rows: [{ name: 'Acme CI' }] }
      return { rows: [{ id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.com' }, { id: '00000000-0000-4000-8000-000000000002', email: 'dev@example.com' }] }
    })
  })

  afterEach(() => {
    if (originalApiSecret === undefined)
      delete process.env.API_SECRET
    else
      process.env.API_SECRET = originalApiSecret
  })

  it('sends one rotation event to every remaining org member', async () => {
    const response = await sendRevocation({
      owner_org_id: ORG_ID,
      apikeys: [
        { id: 7, name: 'CI deploy', previous_recipient_user_id: REMOVED_USER_ID },
        { id: 8, name: 'Nightly build', previous_recipient_user_id: REMOVED_USER_ID },
      ],
    })

    expect(response.status).toBe(200)
    expect(trackBentoRecipientEventsMock).toHaveBeenCalledTimes(1)
    const events = (trackBentoRecipientEventsMock.mock.calls[0] as unknown[])[1]
    expect(events).toEqual([
      { email: 'admin@example.com', event: 'org:shared_apikey_rotated', data: { org_id: ORG_ID, org_name: 'Acme CI', apikeys_url: expect.any(String) } },
      { email: 'dev@example.com', event: 'org:shared_apikey_rotated', data: { org_id: ORG_ID, org_name: 'Acme CI', apikeys_url: expect.any(String) } },
    ])
    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls[1][0]).toContain('rb.scope_type = public.rbac_scope_org()')
    expect(queryMock.mock.calls[1][1]).toEqual([ORG_ID, null, 101])
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('returns a retryable failure without advancing the cursor when Bento fails', async () => {
    trackBentoRecipientEventsMock.mockResolvedValue(false)
    const response = await sendRevocation({ owner_org_id: ORG_ID, apikeys: [{ id: 7, name: 'CI deploy', previous_recipient_user_id: null }] })
    expect(response.status).toBe(503)
    expect(queryMock.mock.calls.some(call => call[0].includes('pgmq.send'))).toBe(false)
  })

  it('sends a bounded batch and queues only the next page without key metadata', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      email: `member-${index}@example.com`,
    }))
    queryMock.mockImplementation(async (text: string) => text.includes('FROM public.orgs') ? { rows: [{ name: 'Acme CI' }] } : { rows })
    const response = await sendRevocation({ owner_org_id: ORG_ID, after_user_id: PAGE_CURSOR_USER_ID })
    expect(response.status).toBe(200)
    expect((trackBentoRecipientEventsMock.mock.calls[0] as unknown[])[1]).toHaveLength(100)
    expect(queryMock.mock.calls[1][1]).toEqual([ORG_ID, PAGE_CURSOR_USER_ID, 101])
    const sendCall = queryMock.mock.calls.find(call => call[0].includes('pgmq.send'))!
    expect(sendCall[1][0]).toBe('on_shared_apikey_secret_revoked')
    expect(JSON.parse(sendCall[1][1]).payload.record).toEqual({ owner_org_id: ORG_ID, after_user_id: rows[99].id })
    expect(sendCall[1][2]).toBe(1)
  })

  it('does nothing when the org no longer exists', async () => {
    queryMock.mockImplementation(async () => ({ rows: [] }))
    const response = await sendRevocation({
      owner_org_id: ORG_ID,
      apikeys: [{ id: 7, name: 'CI deploy', previous_recipient_user_id: null }],
    })

    expect(response.status).toBe(200)
    expect(trackBentoRecipientEventsMock).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads', async () => {
    const response = await sendRevocation({ owner_org_id: ORG_ID, apikeys: [] })

    expect(response.status).toBe(400)
    expect(trackBentoRecipientEventsMock).not.toHaveBeenCalled()
  })
})
