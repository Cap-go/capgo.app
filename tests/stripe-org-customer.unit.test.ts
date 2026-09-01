import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createCustomerMock,
  getDefaultPlanMock,
  getStripeCustomerMock,
  supabaseAdminMock,
} = vi.hoisted(() => ({
  createCustomerMock: vi.fn(),
  getDefaultPlanMock: vi.fn(),
  getStripeCustomerMock: vi.fn(),
  supabaseAdminMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  createCustomer: createCustomerMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  getDefaultPlan: getDefaultPlanMock,
  getStripeCustomer: getStripeCustomerMock,
  supabaseAdmin: supabaseAdminMock,
}))

const { createStripeCustomer, finalizePendingStripeCustomer, isPendingStripeCustomerId, isProvisionedStripeCustomerId } = await import('../supabase/functions/_backend/utils/stripe_org.ts')

const ORG_ID = 'b0dfb856-7ed2-4420-bfca-64d67fe65a4e'
const USER_ID = 'a1bb59b7-34b3-4e06-a0f1-2cc696f043dc'
const PENDING_ID = `pending_${ORG_ID}`
const CUSTOMER_ID = 'cus_VAgMn1agG4iQSC'
const SOLO_PLAN = { name: 'Solo', stripe_id: 'prod_solo' }

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'stripe-org-customer-test' : undefined,
  } as any
}

function createOrg(customerId: string | null) {
  return {
    id: ORG_ID,
    created_by: USER_ID,
    customer_id: customerId,
    management_email: 'dmitriy.kurakin@wn.media',
    name: 'WN Hub',
  } as any
}

function mockSupabase(options: {
  orgCustomerId: string | null
  insertError?: { code?: string, message?: string } | null
  updateError?: { message?: string } | null
  deleteError?: { message?: string } | null
}) {
  const orgState = { customer_id: options.orgCustomerId }
  const stripeInfoInsert = vi.fn(async () => ({ error: options.insertError ?? null }))
  const stripeInfoDeleteEq = vi.fn(async () => ({ error: options.deleteError ?? null }))
  const orgUpdate = vi.fn(async (payload: { customer_id: string }) => {
    if (options.updateError)
      return { error: options.updateError }
    orgState.customer_id = payload.customer_id
    return { error: null }
  })

  supabaseAdminMock.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'orgs') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: createOrg(orgState.customer_id),
                error: null,
              }),
            }),
          }),
          update: (payload: { customer_id: string }) => ({
            eq: async () => await orgUpdate(payload),
          }),
        }
      }
      if (table === 'stripe_info') {
        return {
          insert: stripeInfoInsert,
          delete: () => ({
            eq: stripeInfoDeleteEq,
          }),
        }
      }
      if (table === 'plans') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: SOLO_PLAN, error: null }),
              maybeSingle: async () => ({ data: { name: SOLO_PLAN.name }, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }))

  return { orgState, stripeInfoInsert, stripeInfoDeleteEq, orgUpdate }
}

describe('stripe org customer helpers', () => {
  it.concurrent('treats pending_ ids as unprovisioned', () => {
    expect(isPendingStripeCustomerId(PENDING_ID)).toBe(true)
    expect(isProvisionedStripeCustomerId(PENDING_ID)).toBe(false)
    expect(isProvisionedStripeCustomerId(CUSTOMER_ID)).toBe(true)
    expect(isProvisionedStripeCustomerId(null)).toBe(false)
  })
})

describe('createStripeCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDefaultPlanMock.mockResolvedValue(SOLO_PLAN)
    getStripeCustomerMock.mockResolvedValue({ product_id: SOLO_PLAN.stripe_id })
    createCustomerMock.mockResolvedValue({ id: CUSTOMER_ID })
  })

  it('skips Stripe create when the org already has a real customer', async () => {
    mockSupabase({ orgCustomerId: CUSTOMER_ID })

    const planName = await createStripeCustomer(createContext(), createOrg(PENDING_ID))

    expect(planName).toBe('Solo')
    expect(createCustomerMock).not.toHaveBeenCalled()
  })

  it('reuses the Stripe customer when stripe_info insert hits a unique violation', async () => {
    const { orgUpdate, stripeInfoInsert } = mockSupabase({
      orgCustomerId: PENDING_ID,
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })

    const planName = await createStripeCustomer(createContext(), createOrg(PENDING_ID))

    expect(planName).toBe('Solo')
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
    expect(stripeInfoInsert).toHaveBeenCalledTimes(1)
    expect(orgUpdate).toHaveBeenCalledWith({ customer_id: CUSTOMER_ID })
  })

  it('does not overwrite a different already-provisioned customer id', async () => {
    const existingId = 'cus_existing_org'
    createCustomerMock.mockResolvedValue({ id: CUSTOMER_ID })
    getStripeCustomerMock.mockImplementation(async (_c: unknown, customerId: string) => {
      if (customerId === PENDING_ID)
        return { product_id: SOLO_PLAN.stripe_id }
      return { product_id: SOLO_PLAN.stripe_id, customer_id: customerId }
    })

    let orgSelectCount = 0
    supabaseAdminMock.mockImplementation(() => ({
      from: (table: string) => {
        if (table === 'orgs') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => {
                  orgSelectCount += 1
                  return {
                    data: createOrg(orgSelectCount === 1 ? PENDING_ID : existingId),
                    error: null,
                  }
                },
              }),
            }),
            update: () => ({
              eq: async () => {
                throw new Error('should not overwrite existing customer')
              },
            }),
          }
        }
        if (table === 'stripe_info') {
          return {
            insert: async () => ({ error: null }),
          }
        }
        if (table === 'plans') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: SOLO_PLAN, error: null }),
                maybeSingle: async () => ({ data: { name: SOLO_PLAN.name }, error: null }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    }))

    const planName = await createStripeCustomer(createContext(), createOrg(PENDING_ID))

    expect(planName).toBe('Solo')
    expect(createCustomerMock).toHaveBeenCalledTimes(1)
  })
})

describe('finalizePendingStripeCustomer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDefaultPlanMock.mockResolvedValue(SOLO_PLAN)
    getStripeCustomerMock.mockResolvedValue({ product_id: SOLO_PLAN.stripe_id })
    createCustomerMock.mockResolvedValue({ id: CUSTOMER_ID })
  })

  it('does not create another Stripe customer on retry after the org is linked', async () => {
    const { stripeInfoDeleteEq } = mockSupabase({ orgCustomerId: CUSTOMER_ID })

    const planName = await finalizePendingStripeCustomer(createContext(), createOrg(PENDING_ID))

    expect(planName).toBe('Solo')
    expect(createCustomerMock).not.toHaveBeenCalled()
    expect(stripeInfoDeleteEq).toHaveBeenCalledWith('customer_id', PENDING_ID)
  })
})
