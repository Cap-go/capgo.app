import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const mocks = vi.hoisted(() => ({
  fetchOrgBillingPaidAt: vi.fn().mockResolvedValue({ data: { paid_at: null }, error: null }),
}))

vi.mock('../src/services/organizations', () => ({
  fetchOrgBillingPaidAt: mocks.fetchOrgBillingPaidAt,
}))

describe('billing paid-at cache', () => {
  beforeEach(() => {
    mocks.fetchOrgBillingPaidAt.mockClear()
    mocks.fetchOrgBillingPaidAt.mockResolvedValue({ data: { paid_at: null }, error: null })
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

    expect(mocks.fetchOrgBillingPaidAt).toHaveBeenCalledTimes(1)
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

    expect(mocks.fetchOrgBillingPaidAt).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed lookups', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.fetchOrgBillingPaidAt.mockResolvedValue({ data: null, error: new Error('lookup failed') })
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const orgId = ref(crypto.randomUUID())

    const first = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(first.billingLookupFailed.value).toBe(true))

    const second = useBillingPaidAt(orgId)
    await vi.waitFor(() => expect(second.billingLookupFailed.value).toBe(true))

    expect(mocks.fetchOrgBillingPaidAt).toHaveBeenCalledTimes(2)
  })
})
