import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: (...args: unknown[]) => mocks.from(...args),
  }),
}))

const { get } = await import('../supabase/functions/_backend/public/bundle/get.ts')

function createContext() {
  return {
    json: (body: unknown) => Response.json(body),
  } as any
}

describe('bundle get empty list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkPermission.mockResolvedValue(true)
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [],
        error: null,
      }),
    })
  })

  it('returns an empty array when the app has no bundles', async () => {
    const response = await get(
      createContext(),
      { app_id: 'com.example.app' },
      { key: 'test-key' } as any,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual([])
  })
})
