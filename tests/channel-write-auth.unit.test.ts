import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }))

vi.mock('@supabase/supabase-js', () => ({ createClient }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

function requestContext() {
  return {
    env: {
      SUPABASE_URL: 'http://supabase.test',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    },
    get(key: string) {
      if (key === 'requestId')
        return 'request-id'
      if (key === 'auth') {
        return {
          authType: 'apikey',
          apikey: { key: 'scoped-key' },
          jwt: null,
          userId: 'user-id',
        }
      }
      return undefined
    },
  } as any
}

function channelInsert() {
  return {
    app_id: 'com.test.channel-write',
    created_by: 'creator-id',
    name: 'production',
    owner_org: '00000000-0000-0000-0000-000000000001',
    public: false,
    version: 123,
  } as any
}

function requestClient() {
  const throwOnError = vi.fn().mockResolvedValue({ data: { id: 42 }, error: null })
  const table = {
    eq: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
    update: vi.fn(),
    throwOnError,
  }
  table.eq.mockReturnValue(table)
  table.insert.mockReturnValue(table)
  table.select.mockReturnValue(table)
  table.single.mockReturnValue(table)
  table.update.mockReturnValue(table)
  return {
    client: { from: vi.fn().mockReturnValue(table) },
    table,
  }
}

describe('channel write authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the request-scoped client and omits immutable and preserved fields on an existing channel', async () => {
    const { client, table } = requestClient()
    createClient.mockReturnValue(client)
    const { updateOrCreateChannel } = await import('../supabase/functions/_backend/utils/supabase.ts')

    await updateOrCreateChannel(requestContext(), channelInsert(), 42, true)

    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      global: { headers: { capgkey: 'scoped-key' } },
    }))
    expect(client.from).toHaveBeenCalledWith('channels')
    expect(table.update).toHaveBeenCalledWith(expect.not.objectContaining({
      created_by: expect.anything(),
      version: expect.anything(),
    }))
    expect(table.insert).not.toHaveBeenCalled()
    expect(table.eq).toHaveBeenNthCalledWith(1, 'id', 42)
  })

  it('uses the request-scoped insert policy for a new channel', async () => {
    const { client, table } = requestClient()
    createClient.mockReturnValue(client)
    const { updateOrCreateChannel } = await import('../supabase/functions/_backend/utils/supabase.ts')
    const insert = channelInsert()

    await updateOrCreateChannel(requestContext(), insert, null)

    expect(table.insert).toHaveBeenCalledWith(insert)
    expect(table.select).toHaveBeenCalledWith('id')
    expect(table.single).toHaveBeenCalledTimes(1)
    expect(table.update).not.toHaveBeenCalled()
  })
})
