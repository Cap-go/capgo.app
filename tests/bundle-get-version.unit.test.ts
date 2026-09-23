import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(async () => true),
  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  order: vi.fn(async () => ({ data: [], error: null })),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

function createVersionQuery() {
  const query = {
    eq: vi.fn(() => query),
    maybeSingle: mocks.maybeSingle,
    range: vi.fn(() => ({
      order: mocks.order,
    })),
  }
  return query
}

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: () => ({
      select: () => createVersionQuery(),
    }),
  }),
}))

const { get } = await import('../supabase/functions/_backend/public/bundle/get.ts')

function createContext() {
  return {
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as any
}

describe('bundle get version lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.mockResolvedValue({ data: [], error: null })
  })

  it('returns a single version row when version query param is set', async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: {
        id: 12,
        name: '1.0.0',
        checksum: 'abc',
        deleted: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    })

    const response = await get(
      createContext(),
      { app_id: 'com.example.app', version: '1.0.0' },
      { key: 'test-key' } as any,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { id?: number, name?: string }
    expect(body).toEqual({
      id: 12,
      name: '1.0.0',
      checksum: 'abc',
      deleted: false,
      created_at: '2026-01-01T00:00:00.000Z',
    })
  })

  it('throws 404 when the requested version does not exist', async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null })

    await expect(get(
      createContext(),
      { app_id: 'com.example.app', version: '9.9.9' },
      { key: 'test-key' } as any,
    )).rejects.toThrow('Cannot find bundle')
  })
})
