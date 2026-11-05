import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const mocks = vi.hoisted(() => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { stripe_info: null }, error: null })
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from, maybeSingle, useConsole: vi.fn(() => ({ from })) }
})

vi.mock('../src/services/console', () => ({ useConsole: mocks.useConsole }))

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

  it('shares one in-flight lookup between concurrent callers for the same organization', async () => {
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const orgId = ref(crypto.randomUUID())

    const first = useBillingPaidAt(orgId)
    const second = useBillingPaidAt(orgId)
    await vi.waitFor(() => {
      expect(first.paidAt.value).toBeNull()
      expect(second.paidAt.value).toBeNull()
    })

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

  it('flags orgs that never paid and had a zero-length trial', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { created_at: '2026-10-20T12:00:00.000Z', stripe_info: { paid_at: null, trial_at: '2026-10-20T12:00:00.000Z' } }, error: null })
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const result = useBillingPaidAt(ref(crypto.randomUUID()))

    await vi.waitFor(() => expect(result.paidAt.value).toBeNull())
    expect(result.trialSkipped.value).toBe(true)
  })

  it('does not flag a churned direct-offer customer that already paid', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { created_at: '2026-10-20T12:00:00.000Z', stripe_info: { paid_at: '2026-10-21T08:00:00.000Z', trial_at: '2026-10-20T12:00:00.000Z' } }, error: null })
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const result = useBillingPaidAt(ref(crypto.randomUUID()))

    await vi.waitFor(() => expect(result.paidAt.value).toBe('2026-10-21T08:00:00.000Z'))
    expect(result.trialSkipped.value).toBe(false)
  })

  it('does not flag a standard 15-day trial', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { created_at: '2026-10-20T12:00:00.000Z', stripe_info: { paid_at: null, trial_at: '2026-11-04T12:00:00.000Z' } }, error: null })
    const { useBillingPaidAt } = await import('../src/composables/useBillingPaidAt')
    const result = useBillingPaidAt(ref(crypto.randomUUID()))

    await vi.waitFor(() => expect(result.paidAt.value).toBeNull())
    expect(result.trialSkipped.value).toBe(false)
  })
})
