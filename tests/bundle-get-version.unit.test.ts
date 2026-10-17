import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  result: vi.fn(),
  eqCalls: [] as Array<[string, unknown]>,
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

function createVersionQuery() {
  const query: any = {
    eq: vi.fn((column: string, value: unknown) => {
      mocks.eqCalls.push([column, value])
      return query
    }),
    limit: vi.fn(() => query),
    order: vi.fn(() => query),
    range: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => mocks.result().then(resolve, reject),
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

const row = {
  id: 12,
  name: '1.0.0',
  checksum: 'abc',
  deleted: true,
  created_at: '2026-01-01T00:00:00.000Z',
}

describe('bundle get version lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.eqCalls.length = 0
    mocks.checkPermission.mockResolvedValue(true)
    mocks.result.mockResolvedValue({ data: [], error: null })
  })

  it('excludes deleted bundles by default', async () => {
    const response = await get(createContext(), { app_id: 'com.example.app', version: '1.0.0' }, { key: 'test-key' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect(mocks.eqCalls).toContainEqual(['deleted', false])
  })

  it('include_deleted matches soft-deleted bundles for name occupancy checks', async () => {
    mocks.result.mockResolvedValueOnce({ data: [row], error: null })

    const response = await get(createContext(), { app_id: 'com.example.app', version: '1.0.0', include_deleted: '1' }, { key: 'test-key' } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([row])
    expect(mocks.eqCalls).not.toContainEqual(['deleted', false])
    expect(mocks.eqCalls).toContainEqual(['name', '1.0.0'])
  })
})
