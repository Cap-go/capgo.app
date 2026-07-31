import type { Mock } from 'vitest'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkPermissionMock,
  supabaseClientMock,
  supabaseApikeyMock,
  apikeyHasOrgRightWithPolicyMock,
  supabaseAdminMock,
  updateCustomerOrganizationNameMock,
  getStripeCustomerNameMock,
  isDeterministicStripeCustomerUpdateErrorMock,
  getPgClientMock,
  closeClientMock,
} = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  supabaseClientMock: vi.fn(),
  supabaseApikeyMock: vi.fn(),
  apikeyHasOrgRightWithPolicyMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
  updateCustomerOrganizationNameMock: vi.fn(),
  getStripeCustomerNameMock: vi.fn(),
  isDeterministicStripeCustomerUpdateErrorMock: vi.fn(),
  getPgClientMock: vi.fn(),
  closeClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  updateCustomerOrganizationName: (...args: unknown[]) => updateCustomerOrganizationNameMock(...args),
  getStripeCustomerName: (...args: unknown[]) => getStripeCustomerNameMock(...args),
  isDeterministicStripeCustomerUpdateError: (...args: unknown[]) => isDeterministicStripeCustomerUpdateErrorMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseClient: (...args: unknown[]) => supabaseClientMock(...args),
  supabaseApikey: (...args: unknown[]) => supabaseApikeyMock(...args),
  apikeyHasOrgRightWithPolicy: (...args: unknown[]) => apikeyHasOrgRightWithPolicyMock(...args),
  supabaseAdmin: (...args: unknown[]) => supabaseAdminMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: (...args: unknown[]) => getPgClientMock(...args),
  closeClient: (...args: unknown[]) => closeClientMock(...args),
}))

const { put } = await import('../supabase/functions/_backend/public/organization/put.ts')
type OrgRow = Database['public']['Tables']['orgs']['Row']

function createContext(options?: {
  auth?: {
    userId: string
    authType: 'apikey' | 'jwt'
    apikey: Database['public']['Tables']['apikeys']['Row'] | null
    jwt: string | null
  }
  capgkey?: string
}) {
  return {
    get: (key: string) => {
      if (key === 'auth') {
        return options?.auth ?? {
          userId: 'user-123',
          authType: 'jwt',
          apikey: null,
          jwt: 'jwt-token',
          claims: { sub: 'user-123', role: 'authenticated', aal: 'aal2', amr: [{ method: 'totp' }] },
        }
      }
      if (key === 'capgkey')
        return options?.capgkey
      return undefined
    },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  } as any
}

function createOrgRow(overrides: Partial<OrgRow> & Pick<OrgRow, 'id' | 'name' | 'customer_id'>): OrgRow {
  const baseOrgRow: OrgRow = {
    created_at: null,
    created_by: 'user-123',
    customer_id: 'cus_123',
    email_preferences: {},
    enforce_encrypted_bundles: false,
    enforce_hashed_api_keys: false,
    enforcing_2fa: false,
    has_usage_credits: false,
    id: 'org-123',
    last_stats_updated_at: null,
    logo: null,
    management_email: 'billing@capgo.app',
    max_apikey_expiration_days: null,
    name: 'Old Name',
    onboarding: { intent: 'unknown' },
    password_policy_config: null,
    require_apikey_expiration: false,
    required_encryption_key: null,
    stats_refresh_requested_at: null,
    stats_updated_at: null,
    updated_at: null,
    website: 'https://old.example',
  }

  return {
    ...baseOrgRow,
    ...overrides,
  }
}

function createOrgSelectBuilder(data: OrgRow) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

interface OrganizationUpdateBuilder {
  data: Partial<OrgRow> | null
  error: { message: string } | null
  update: Mock<(fields: Record<string, unknown>) => OrganizationUpdateBuilder>
  eq: Mock<(field: string, value: unknown) => OrganizationUpdateBuilder>
  is: Mock<(field: string, value: unknown) => OrganizationUpdateBuilder>
  select: Mock<() => OrganizationUpdateBuilder>
  maybeSingle: Mock<() => Promise<{ data: Partial<OrgRow> | null, error: { message: string } | null }>>
}

const pendingOrganizationUpdates: OrganizationUpdateBuilder[] = []
let organizationUpdateQueryMock: ReturnType<typeof vi.fn>

function createOrgUpdateBuilder(data: Partial<OrgRow> | null, error: { message: string } | null = null) {
  const builder: OrganizationUpdateBuilder = {
    data,
    error,
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  }
  pendingOrganizationUpdates.push(builder)
  return builder
}

function recordDirectOrganizationUpdate(builder: OrganizationUpdateBuilder, text: string, params: unknown[] = []) {
  const assignmentText = text.match(/^UPDATE public\.orgs SET (.+) WHERE /)?.[1]
  if (assignmentText) {
    const updateFields = Object.fromEntries(assignmentText.split(', ').map((assignment) => {
      const [, field, parameter] = assignment.match(/^(\w+) = \$(\d+)$/) ?? []
      return [field, params[Number(parameter) - 1]]
    }))
    builder.update(updateFields)
  }

  for (const match of text.matchAll(/(?:^| AND )(\w+) = \$(\d+)/g)) {
    const [, field, parameter] = match
    if (field !== 'id')
      builder.eq(field, params[Number(parameter) - 1])
  }
}

function mockOrganizationUpdates() {
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    if (text.startsWith('UPDATE public.orgs')) {
      const builder = pendingOrganizationUpdates.shift()
      if (!builder)
        return { rows: [] }
      recordDirectOrganizationUpdate(builder, text, params)
      const { data, error } = await builder.maybeSingle()
      if (error)
        throw new Error(error.message)
      return { rows: data ? [data] : [] }
    }
    return { rows: [] }
  })
  organizationUpdateQueryMock = query
  const client = {
    query,
    release: vi.fn(),
  }
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  }
  getPgClientMock.mockReturnValue(pool)
  return { client, pool }
}

function getOrganizationUpdateCalls() {
  return organizationUpdateQueryMock.mock.calls.filter(([text]) => typeof text === 'string' && text.startsWith('UPDATE public.orgs'))
}

function createSupabaseClientStub(
  from: ReturnType<typeof vi.fn>,
  sanitizedName = 'New Name',
) {
  return {
    from,
    rpc: vi.fn().mockResolvedValue({ data: sanitizedName, error: null }),
  }
}

describe('organization put Stripe sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingOrganizationUpdates.length = 0
    closeClientMock.mockResolvedValue(undefined)
    mockOrganizationUpdates()
    checkPermissionMock.mockResolvedValue(true)
    updateCustomerOrganizationNameMock.mockResolvedValue(undefined)
    getStripeCustomerNameMock.mockResolvedValue(undefined)
    isDeterministicStripeCustomerUpdateErrorMock.mockReturnValue(false)
    apikeyHasOrgRightWithPolicyMock.mockResolvedValue({ valid: true })
  })

  it('uses the raw request key for hashed API key org updates', async () => {
    const rawKey = 'ck_test_raw_hashed_org_update_key'
    const hashedApikey = {
      created_at: '2026-06-05T00:00:00Z',
      expires_at: null,
      id: 123,
      key: null,
      key_hash: 'stored-hash',
      name: 'hashed org update key',
      rbac_id: 'rbac-apikey-123',
      updated_at: null,
      user_id: 'user-123',
    } satisfies Database['public']['Tables']['apikeys']['Row']
    const updateBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
      enforce_hashed_api_keys: true,
    }))
    const rlsSupabase = createSupabaseClientStub(
      vi.fn().mockReturnValueOnce(updateBuilder),
    )

    supabaseApikeyMock.mockReturnValue(rlsSupabase)

    const response = await put(createContext({
      auth: {
        userId: 'user-123',
        authType: 'apikey',
        apikey: hashedApikey,
        jwt: null,
      },
      capgkey: rawKey,
    }), {
      orgId: 'org-123',
      enforce_hashed_api_keys: true,
    }, hashedApikey)

    expect(response.status).toBe(200)
    expect(supabaseApikeyMock).toHaveBeenCalledWith(expect.anything(), rawKey)
    expect(apikeyHasOrgRightWithPolicyMock).toHaveBeenCalledWith(expect.anything(), hashedApikey, 'org-123', rlsSupabase)
    expect(supabaseAdminMock).not.toHaveBeenCalled()
    expect(updateBuilder.update).toHaveBeenCalledWith({ enforce_hashed_api_keys: true })
  })

  it('updates the org row before syncing Stripe customer name', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
      logo: null,
    })

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const response = await put(createContext(), {
      orgId: 'org-123',
      name: '  <b>New Name</b>  ',
    }, undefined)

    expect(response.status).toBe(200)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledTimes(1)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledWith(expect.anything(), 'cus_123', 'New Name')
    expect(updateBuilder.update).toHaveBeenCalledWith({ name: 'New Name' })
    expect(updateBuilder.eq).toHaveBeenCalledWith('name', 'Old Name')
    expect(updateBuilder.maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(updateCustomerOrganizationNameMock.mock.invocationCallOrder[0])
    expect(organizationUpdateQueryMock).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: 'user-123', role: 'authenticated', aal: 'aal2', amr: [{ method: 'totp' }] }),
    ])
    expect(organizationUpdateQueryMock).toHaveBeenCalledWith('SELECT set_config($1, $2, true)', ['request.headers', '{}'])
    const roleCallIndex = organizationUpdateQueryMock.mock.calls.findIndex(([text]) => text === 'SET LOCAL ROLE authenticated')
    const updateCallIndex = organizationUpdateQueryMock.mock.calls.findIndex(([text]) => typeof text === 'string' && text.startsWith('UPDATE public.orgs'))
    expect(roleCallIndex).toBeGreaterThanOrEqual(0)
    expect(roleCallIndex).toBeLessThan(updateCallIndex)
  })

  it('syncs Stripe using the committed customer id when it becomes available during the rename', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'pending_org-123',
    }))
    const updateBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
    }))

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const response = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined)

    expect(response.status).toBe(200)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledWith(expect.anything(), 'cus_123', 'New Name')
  })

  it('does not touch Stripe when a competing rename wins the database write', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder(null)

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(updateCustomerOrganizationNameMock).not.toHaveBeenCalled()
    expect(error.cause.moreInfo).toMatchObject({
      error: 'org_name_changed',
      orgId: 'org-123',
    })
  })

  it('does not touch Stripe when the database update fails before commit', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder(null, { message: 'db write failed' })

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(updateCustomerOrganizationNameMock).not.toHaveBeenCalled()
    expect(error.cause.moreInfo).toMatchObject({
      error: 'db write failed',
    })
  })

  it('rolls the org row back when syncing Stripe fails', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
      website: 'https://old.example',
    }))
    const updateBuilder = createOrgUpdateBuilder({
      ...createOrgRow({
        id: 'org-123',
        name: 'New Name',
        customer_id: 'cus_123',
        updated_at: '2026-04-15T13:00:00Z',
        website: 'https://new.example',
      }),
    })
    const rollbackBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
      website: 'https://old.example',
    }))

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder)
        .mockReturnValueOnce(rollbackBuilder),
    ))

    updateCustomerOrganizationNameMock
      .mockRejectedValueOnce(new Error('Stripe update failed'))
    getStripeCustomerNameMock.mockResolvedValueOnce('Old Name')

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
      website: 'https://new.example',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledWith(expect.anything(), 'cus_123', 'New Name')
    expect(rollbackBuilder.update).toHaveBeenCalledWith({
      name: 'Old Name',
      website: 'https://old.example',
    })
    expect(rollbackBuilder.eq).toHaveBeenCalledWith('name', 'New Name')
    expect(rollbackBuilder.eq).toHaveBeenCalledWith('website', 'https://new.example')
    expect(error.cause.moreInfo).toMatchObject({
      error: 'Stripe update failed',
    })
  })

  it('keeps the org row when Stripe already persisted the renamed customer name', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
      updated_at: '2026-04-15T13:00:00Z',
    }))

    const from = vi.fn()
      .mockReturnValueOnce(selectBuilder)
      .mockReturnValueOnce(updateBuilder)

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(from))

    updateCustomerOrganizationNameMock
      .mockRejectedValueOnce(new Error('connection reset'))
    getStripeCustomerNameMock.mockResolvedValueOnce('New Name')

    const response = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined)

    expect(response.status).toBe(200)
    expect(getStripeCustomerNameMock).toHaveBeenCalledWith(expect.anything(), 'cus_123')
    expect(from).toHaveBeenCalledTimes(1)
    expect(getOrganizationUpdateCalls()).toHaveLength(1)
  })

  it('includes both errors when the database rollback fails after Stripe sync error', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder({
      ...createOrgRow({
        id: 'org-123',
        name: 'New Name',
        customer_id: 'cus_123',
        updated_at: '2026-04-15T13:00:00Z',
      }),
    })
    const rollbackBuilder = createOrgUpdateBuilder(null, { message: 'rollback failed' })

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder)
        .mockReturnValueOnce(rollbackBuilder),
    ))

    updateCustomerOrganizationNameMock
      .mockRejectedValueOnce(new Error('Stripe update failed'))
    getStripeCustomerNameMock.mockResolvedValueOnce('Old Name')

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(error.cause.moreInfo).toMatchObject({
      error: 'Stripe update failed',
      rollbackError: 'rollback failed',
    })
  })

  it('does not roll back the org row when Stripe state is unknown after a transport failure', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
      updated_at: '2026-04-15T13:00:00Z',
    }))

    const from = vi.fn()
      .mockReturnValueOnce(selectBuilder)
      .mockReturnValueOnce(updateBuilder)

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(from))

    updateCustomerOrganizationNameMock
      .mockRejectedValueOnce(new Error('connection reset'))
    getStripeCustomerNameMock.mockResolvedValueOnce(undefined)
    isDeterministicStripeCustomerUpdateErrorMock.mockReturnValueOnce(false)

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(error.cause.moreInfo).toMatchObject({
      error: 'connection reset',
      stripeSyncState: 'unknown',
    })
    expect(from).toHaveBeenCalledTimes(1)
    expect(getOrganizationUpdateCalls()).toHaveLength(1)
  })

  it('retries Stripe sync when the requested name already matches the committed org row', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
    }))
    const updateBuilder = createOrgUpdateBuilder(createOrgRow({
      id: 'org-123',
      name: 'New Name',
      customer_id: 'cus_123',
      updated_at: '2026-04-15T13:00:00Z',
    }))

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const response = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined)

    expect(response.status).toBe(200)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledTimes(1)
    expect(updateCustomerOrganizationNameMock).toHaveBeenCalledWith(expect.anything(), 'cus_123', 'New Name')
  })

  it('rejects blank names after HTML stripping', async () => {
    const from = vi.fn()
    const rpc = vi.fn().mockResolvedValue({ data: '   ', error: null })

    supabaseClientMock.mockReturnValue({ from, rpc })

    const error = await put(createContext(), {
      orgId: 'org-123',
      name: '<b></b>',
    }, undefined).catch(caught => caught)

    expect(error).toBeInstanceOf(HTTPException)
    expect(error.cause.moreInfo).toMatchObject({
      error: 'sanitized_name_empty',
    })
    expect(from).not.toHaveBeenCalled()
    expect(updateCustomerOrganizationNameMock).not.toHaveBeenCalled()
  })

  it('skips Stripe sync for pending customer ids', async () => {
    const selectBuilder = createOrgSelectBuilder(createOrgRow({
      id: 'org-123',
      name: 'Old Name',
      customer_id: 'pending_org-123',
    }))
    const updateBuilder = createOrgUpdateBuilder({
      ...createOrgRow({
        id: 'org-123',
        name: 'New Name',
        customer_id: 'pending_org-123',
      }),
      id: 'org-123',
      logo: null,
    })

    supabaseClientMock.mockReturnValue(createSupabaseClientStub(
      vi.fn()
        .mockReturnValueOnce(selectBuilder)
        .mockReturnValueOnce(updateBuilder),
    ))

    const response = await put(createContext(), {
      orgId: 'org-123',
      name: 'New Name',
    }, undefined)

    expect(response.status).toBe(200)
    expect(updateCustomerOrganizationNameMock).not.toHaveBeenCalled()
    expect(updateBuilder.update).toHaveBeenCalledWith({ name: 'New Name' })
  })
})
