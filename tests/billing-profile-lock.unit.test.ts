import { beforeEach, expect, it, vi } from 'vitest'
import { withBillingProfileLock } from '../supabase/functions/_backend/utils/billing_profile_lock'
import { resumeSubscription } from '../supabase/functions/_backend/utils/stripe_in_app'

const state = vi.hoisted(() => ({ tail: Promise.resolve(), query: vi.fn(), sync: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  servicePrincipal: {},
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown) => Promise<unknown>) => {
    let release: (() => void) | undefined
    const client = { query: async (sql: string, values?: unknown[]) => {
      state.query(sql, values)
      if (sql.includes('pg_advisory_xact_lock')) {
        const previous = state.tail
        state.tail = new Promise<void>(resolve => { release = resolve })
        await previous
      }
      return { rows: [] }
    } }
    try { return await run(client) }
    finally { release?.() }
  },
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ getActiveSubscriptionId: async () => 'sub_example', syncSubscriptionData: async () => {} }))
vi.mock('../supabase/functions/_backend/utils/stripe_billing_profile_sync.ts', () => ({ syncBillingProfile: state.sync }))
vi.mock('../supabase/functions/_backend/utils/billing_currency_discounts.ts', () => ({ updateCurrencyDiscountSchedule: async () => false, currencyScheduleCancelAt: async () => null }))
vi.mock('../supabase/functions/_backend/utils/stripe_trial_plan.ts', () => ({ releaseTrialPlanSchedule: async () => {} }))

beforeEach(() => {
  state.tail = Promise.resolve()
  vi.clearAllMocks()
})

it('keeps both resume writes together when a currency change arrives between them', async () => {
  let resumeWritten!: () => void
  const resumed = new Promise<void>(resolve => { resumeWritten = resolve })
  let continueResume!: () => void
  const pause = new Promise<void>(resolve => { continueResume = resolve })
  const events: string[] = []
  const stripe = {
    subscriptions: {
      update: async () => { events.push('resume subscription'); resumeWritten(); await pause; return { currency: 'usd' } },
      retrieve: async () => ({ items: { data: [] } }),
    },
    customers: { update: vi.fn(async () => { events.push('resume customer') }) },
  }
  const c = { get: () => 'test' } as any
  const ctx = { stripe, customerId: 'cus_example', billingAccount: 'us' } as any
  const resume = resumeSubscription(c, ctx)
  await resumed
  const change = withBillingProfileLock(c, 'us', ctx.customerId, async () => { events.push('change subscription'); events.push('change customer') })
  await Promise.resolve()
  expect(events).toEqual(['resume subscription'])
  continueResume()
  await Promise.all([resume, change])
  expect(events).toEqual(['resume subscription', 'resume customer', 'change subscription', 'change customer'])
  expect(stripe.customers.update).toHaveBeenCalledWith('cus_example', { metadata: { capgo_billing_currency: 'usd' } }, expect.anything())
  expect(state.query.mock.calls.filter(([sql]) => sql.includes('pg_advisory')).map(([, values]) => values)).toEqual([
    ['billing-profile:us:cus_example'], ['billing-profile:us:cus_example'],
  ])
})
