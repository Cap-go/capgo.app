import { beforeEach, expect, it, vi } from 'vitest'
import { syncBillingProfile } from '../supabase/functions/_backend/utils/stripe_billing_profile_sync'
const mocks = vi.hoisted(() => ({ query: vi.fn(), retrieve: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({ servicePrincipal: { kind: 'service' }, withRlsContext: (_c: unknown, _p: unknown, run: (client: unknown) => unknown) => run({ query: mocks.query }) }))
const ctx = { customerId: 'cus_example', billingAccount: 'us', stripe: { subscriptions: { list: async () => ({ data: [] }) }, customers: { retrieve: mocks.retrieve } } } as any
beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue({ rowCount: 1 })
  mocks.retrieve.mockResolvedValue({ address: { country: 'AR', city: 'Example City' }, currency: 'usd' })
})
it('serializes current Stripe reads and writes the address and currency scoped to the billing account', async () => {
  await syncBillingProfile({} as any, ctx)
  expect(mocks.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock')
  expect(mocks.query.mock.calls[1][1]).toEqual(['cus_example', 'AR', JSON.stringify({ country: 'AR', city: 'Example City' }), 'usd', 'us'])
  expect(mocks.retrieve).toHaveBeenCalledWith('cus_example')
})
it('does not overwrite stored data when Stripe is unavailable', async () => {
  mocks.retrieve.mockRejectedValue(new Error('unavailable'))
  await expect(syncBillingProfile({} as any, ctx)).rejects.toThrow('unavailable')
  expect(mocks.query).toHaveBeenCalledTimes(1)
})
it('does not report a successful sync if the customer/account row is missing', async () => {
  mocks.query.mockResolvedValue({ rowCount: 0 })
  await expect(syncBillingProfile({} as any, ctx)).rejects.toThrow()
})

it('persists the selected currency in Capgo even while the old subscription is winding down', async () => {
  mocks.retrieve.mockResolvedValue({ address: { country: 'AR' }, currency: 'ars', metadata: { capgo_billing_currency: 'usd' } })
  await syncBillingProfile({} as any, ctx)
  expect(mocks.query.mock.calls[1][1][3]).toBe('usd')
})

it.each(['USD', 'invalid'])('falls back from malformed preference %s while still saving the address', async (preference) => {
  mocks.retrieve.mockResolvedValue({ address: { country: 'DE' }, currency: 'eur', metadata: { capgo_billing_currency: preference } })
  await syncBillingProfile({} as any, ctx)
  expect(mocks.query.mock.calls[1][1]).toEqual(['cus_example', 'DE', JSON.stringify({ country: 'DE' }), 'eur', 'us'])
})
