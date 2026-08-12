import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const mocks = vi.hoisted(() => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { stripe_info: null }, error: null })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from, maybeSingle, useSupabase: vi.fn(() => ({ from })) }
})

vi.mock('../src/services/supabase', () => ({ useSupabase: mocks.useSupabase }))

describe('billing paid-at cache', () => {
  beforeEach(() => {
    mocks.from.mockClear()
    mocks.maybeSingle.mockReset().mockResolvedValue({ data: { stripe_info: null }, error: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses a recent successful lookup for the same organization', async () => {
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const orgId = ref(crypto.randomUUID())

    const first = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(first.paidAt.value).toBeNull())

    const second = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(second.paidAt.value).toBeNull())

    expect(mocks.from).toHaveBeenCalledTimes(1)
  })

  it('refreshes the lookup after five minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const orgId = ref(crypto.randomUUID())

    const first = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(first.paidAt.value).toBeNull())

    now.mockReturnValue(5 * 60 * 1000 + 1)
    const second = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(second.paidAt.value).toBeNull())

    expect(mocks.from).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed lookups', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: 'lookup failed' } })
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const orgId = ref(crypto.randomUUID())

    const first = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(first.billingLookupFailed.value).toBe(true))

    const second = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(second.billingLookupFailed.value).toBe(true))

    expect(mocks.from).toHaveBeenCalledTimes(2)
  })
})
