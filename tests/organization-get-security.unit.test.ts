import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(async () => true),
  apikeyHasOrgRightWithPolicy: vi.fn(async () => ({ valid: true })),
  createSignedImageUrl: vi.fn(async (value: string) => value),
  from: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: (...args: unknown[]) => mocks.from(...args),
  }),
  apikeyHasOrgRightWithPolicy: (...args: unknown[]) => mocks.apikeyHasOrgRightWithPolicy(...args),
}))

vi.mock('../supabase/functions/_backend/utils/storage.ts', () => ({
  createSignedImageUrl: (...args: unknown[]) => mocks.createSignedImageUrl(...args),
}))

const { get } = await import('../supabase/functions/_backend/public/organization/get.ts')

const orgRow = {
  id: '22222222-2222-4222-8222-222222222222',
  created_by: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  logo: null,
  name: 'Example Org',
  management_email: 'admin@example.com',
  customer_id: null,
  website: 'https://example.com',
  enforcing_2fa: true,
  password_policy_config: {
    enabled: true,
    min_length: 12,
    require_uppercase: true,
    require_number: true,
    require_special: false,
  },
  require_apikey_expiration: true,
  max_apikey_expiration_days: 90,
  enforce_hashed_api_keys: false,
}

function createContext() {
  return {
    json: (body: unknown) => Response.json(body),
  } as any
}

function mockOrgSelect(data: unknown) {
  mocks.from.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
    range: vi.fn().mockResolvedValue({ data: [data], error: null }),
  })
}

describe('organization get security fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns enforcing_2fa and API key policy fields for a single org', async () => {
    mockOrgSelect(orgRow)
    const response = await get(createContext(), { orgId: orgRow.id }, { key: 'test-key' } as any)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.enforcing_2fa).toBe(true)
    expect(body.require_apikey_expiration).toBe(true)
    expect(body.max_apikey_expiration_days).toBe(90)
    expect(body.enforce_hashed_api_keys).toBe(false)
    expect(body.password_policy_config).toEqual(orgRow.password_policy_config)
  })
})
