import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { trackBentoEventMock, isBentoConfiguredMock, queryMock, closeClientMock } = vi.hoisted(() => ({
  trackBentoEventMock: vi.fn(async () => true),
  isBentoConfiguredMock: vi.fn(() => true),
  queryMock: vi.fn(),
  closeClientMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/bento.ts')
  return {
    ...actual,
    isBentoConfigured: isBentoConfiguredMock,
    trackBentoEvent: trackBentoEventMock,
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
    trackBentoEventMock.mockClear()
    isBentoConfiguredMock.mockReturnValue(true)
    queryMock.mockReset()
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM public.orgs'))
        return { rows: [{ name: 'Acme CI' }] }
      if (text.includes('WHERE id = ANY'))
        return { rows: [{ email: 'removed@example.com' }] }
      return { rows: [{ email: 'admin@example.com' }, { email: 'dev@example.com' }] }
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
    expect(trackBentoEventMock).toHaveBeenCalledTimes(2)
    const recipients = trackBentoEventMock.mock.calls.map(call => (call as unknown[])[1])
    expect(recipients).toEqual(['admin@example.com', 'dev@example.com'])
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'admin@example.com',
      expect.objectContaining({
        org_id: ORG_ID,
        org_name: 'Acme CI',
        apikey_count: 2,
        apikey_names: ['CI deploy', 'Nightly build'],
        previous_holder_emails: ['removed@example.com'],
      }),
      'org:shared_apikey_rotated',
    )
    expect(closeClientMock).toHaveBeenCalled()
  })

  it('does nothing when the org no longer exists', async () => {
    queryMock.mockImplementation(async () => ({ rows: [] }))
    const response = await sendRevocation({
      owner_org_id: ORG_ID,
      apikeys: [{ id: 7, name: 'CI deploy', previous_recipient_user_id: null }],
    })

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads', async () => {
    const response = await sendRevocation({ owner_org_id: ORG_ID, apikeys: [] })

    expect(response.status).toBe(400)
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })
})
