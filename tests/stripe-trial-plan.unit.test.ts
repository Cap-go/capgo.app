import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import {
  cancelDuplicateTrialPlanSchedules,
  cancelTrialPlan,
  isTrialPlanFirstInvoiceUnpaid,
  releaseTrialPlanSchedule,
  cancelTrialPlanScheduleForSubscription,
  createStartNowSubscription,
  findPendingTrialPlanSchedule,
  getTrialPlanPriceId,
  getTrialPlanStartDate,
  getTrialPriceTier,
  holdTrialPlanLock,
  settleTrialPlanFirstInvoice,
  syncPendingTrialPlanScheduleWithTrialAt,
  syncTrialPlanScheduleForCustomer,
} from '../supabase/functions/_backend/utils/stripe_trial_plan.ts'

const billingAccountMock = vi.hoisted(() => ({ account: 'ee' as 'ee' | 'us' }))
const stripeClientMock = vi.hoisted(() => ({
  lastAccount: null as 'ee' | 'us' | null,
  stripe: null as Stripe | null,
}))

vi.mock('../supabase/functions/_backend/utils/stripe_billing.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe_billing.ts')>()
  return {
    ...original,
    getBillingAccountForCustomer: vi.fn(async () => billingAccountMock.account),
  }
})

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  getStripe: vi.fn((_c: unknown, account: 'ee' | 'us') => {
    stripeClientMock.lastAccount = account
    return stripeClientMock.stripe
  }),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  const client = {
    query: vi.fn(async (text: string) => {
      if (text.startsWith('BEGIN') || text.includes('pg_advisory') || text === 'COMMIT' || text === 'ROLLBACK' || text === 'SELECT 1')
        return { rows: [] }
      return { rows: [] }
    }),
  }
  return {
    ...original,
    getPgClient: vi.fn(async () => ({})),
    checkoutPgClient: vi.fn(async () => client),
    releasePgClient: vi.fn(),
    closeClient: vi.fn(),
  }
})

// When set, answers the direct-Postgres reads (as the rows of each statement).
const adminRows = vi.hoisted(() => ({ override: null as null | ((text: string) => unknown[]) }))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...original,
    withRlsContext: ((...args: Parameters<typeof original.withRlsContext>) => {
      const override = adminRows.override
      if (!override)
        return original.withRlsContext(...args)
      const [, , run] = args
      return run({ query: async (text: string) => ({ rows: override(text) }) } as any, {} as any)
    }) as typeof original.withRlsContext,
  }
})

const context = { get: () => 'request-id' } as any

function fakeStripe(schedules: Array<Partial<Stripe.SubscriptionSchedule>>) {
  const cancel = vi.fn(async (id: string) => ({ id }))
  const list = vi.fn(async (_params: Stripe.SubscriptionScheduleListParams) => ({ data: schedules }))
  const stripe = {
    subscriptionSchedules: { list, cancel },
  } as unknown as Stripe
  return { stripe, cancel, list }
}

function fakeInvoiceStripe(invoice: Partial<Stripe.Invoice>, payResult: 'paid' | 'declined', subscriptionStatus: Stripe.Subscription.Status = 'active') {
  const state = { ...invoice }
  const finalizeInvoice = vi.fn(async () => Object.assign(state, { status: 'open' }))
  const pay = vi.fn(async () => {
    if (payResult === 'declined')
      throw new Error('card_declined')
    return Object.assign(state, { status: 'paid' })
  })
  const release = vi.fn(async (id: string) => ({ id, status: 'released' }))
  const stripe = {
    invoices: { retrieve: vi.fn(async () => ({ ...state })), finalizeInvoice, pay },
    subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, schedule: 'sub_sched_trial', status: subscriptionStatus, latest_invoice: 'in_1', metadata: { capgo_trial_plan: 'true' } })) },
    subscriptionSchedules: {
      release,
      retrieve: vi.fn(async (id: string) => ({ id, status: 'active', metadata: { capgo_trial_plan: 'true' } })),
    },
  } as unknown as Stripe
  return { stripe, finalizeInvoice, pay, release }
}

const trialSubscription = { id: 'sub_1', latest_invoice: 'in_1', metadata: { capgo_trial_plan: 'true' } } as unknown as Stripe.Subscription

describe('trial plan start date', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z')

  it('starts at 00:00 UTC on the trial end date, when trial access stops', () => {
    expect(getTrialPlanStartDate('2026-11-04T09:30:00.000Z', now)?.toISOString()).toBe('2026-11-04T00:00:00.000Z')
  })

  it('returns null once the trial has ended or for invalid dates', () => {
    expect(getTrialPlanStartDate('2026-10-21T23:00:00.000Z', now)).toBeNull()
    expect(getTrialPlanStartDate('2026-10-01T00:00:00.000Z', now)).toBeNull()
    expect(getTrialPlanStartDate('not a date', now)).toBeNull()
    expect(getTrialPlanStartDate(null, now)).toBeNull()
  })
})

describe('trial plan schedules', () => {
  it('only matches Capgo trial schedules that have not started, oldest first', async () => {
    const { stripe, list } = fakeStripe([
      { id: 'sub_sched_other', status: 'not_started', created: 1, metadata: {} },
      { id: 'sub_sched_done', status: 'released', created: 2, metadata: { capgo_trial_plan: 'true' } },
      { id: 'sub_sched_newer', status: 'not_started', created: 4, metadata: { capgo_trial_plan: 'true' } },
      { id: 'sub_sched_trial', status: 'not_started', created: 3, metadata: { capgo_trial_plan: 'true' } },
    ])
    expect((await findPendingTrialPlanSchedule(stripe, 'cus_1'))?.id).toBe('sub_sched_trial')
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 })
  })

  it('cancels duplicate pending schedules and keeps the oldest', async () => {
    const { stripe, cancel, list } = fakeStripe([
      { id: 'sub_sched_b', status: 'not_started', created: 2, metadata: { capgo_trial_plan: 'true' } },
      { id: 'sub_sched_a', status: 'not_started', created: 1, metadata: { capgo_trial_plan: 'true' } },
    ])
    await cancelDuplicateTrialPlanSchedules(context, stripe, 'cus_1')
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('sub_sched_b')
  })

  it('cancels every pending trial plan when checkout creates another subscription', async () => {
    const { stripe, cancel, list } = fakeStripe([
      { id: 'sub_sched_trial', status: 'not_started', created: 1, metadata: { capgo_trial_plan: 'true' } },
      { id: 'sub_sched_dup', status: 'not_started', created: 2, metadata: { capgo_trial_plan: 'true' } },
    ])
    await cancelTrialPlanScheduleForSubscription(context, stripe, { id: 'sub_1', customer: 'cus_1', schedule: null, status: 'active' } as unknown as Stripe.Subscription)
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 100 })
    expect(cancel).toHaveBeenCalledWith('sub_sched_trial')
    expect(cancel).toHaveBeenCalledWith('sub_sched_dup')
  })

  it('keeps the schedule while the checkout subscription is still incomplete', async () => {
    const { stripe, cancel, list } = fakeStripe([{ id: 'sub_sched_trial', status: 'not_started', metadata: { capgo_trial_plan: 'true' } }])
    await cancelTrialPlanScheduleForSubscription(context, stripe, { id: 'sub_1', customer: 'cus_1', schedule: null, status: 'incomplete' } as unknown as Stripe.Subscription)
    expect(list).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels the pending trial-end schedule once the plan was started now', async () => {
    const { stripe, cancel } = fakeStripe([{ id: 'sub_sched_trial', status: 'not_started', metadata: { capgo_trial_plan: 'true' } }])
    await cancelTrialPlanScheduleForSubscription(context, stripe, {
      id: 'sub_now',
      customer: 'cus_1',
      schedule: null,
      status: 'active',
      metadata: { capgo_trial_plan: 'true', capgo_trial_started_now: 'true' },
    } as unknown as Stripe.Subscription)
    expect(cancel).toHaveBeenCalledWith('sub_sched_trial')
  })

  it('keeps the schedule for the subscription a trial plan schedule started', async () => {
    const { stripe, cancel, list } = fakeStripe([{ id: 'sub_sched_trial', status: 'not_started', metadata: { capgo_trial_plan: 'true' } }])
    await cancelTrialPlanScheduleForSubscription(context, stripe, {
      id: 'sub_trial',
      customer: 'cus_1',
      schedule: null,
      status: 'active',
      metadata: { capgo_trial_plan: 'true' },
    } as unknown as Stripe.Subscription)
    expect(list).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps the schedule when the subscription is the one it started', async () => {
    const { stripe, cancel } = fakeStripe([{ id: 'sub_sched_trial', status: 'not_started', metadata: { capgo_trial_plan: 'true' } }])
    await cancelTrialPlanScheduleForSubscription(context, stripe, { id: 'sub_1', customer: 'cus_1', schedule: 'sub_sched_trial', status: 'active' } as unknown as Stripe.Subscription)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('trial plan first invoice', () => {
  it('charges the draft first invoice and converts once it is paid', async () => {
    const { stripe, finalizeInvoice, pay } = fakeInvoiceStripe({ id: 'in_1', status: 'draft', billing_reason: 'subscription_create' }, 'paid')
    expect(await settleTrialPlanFirstInvoice(context, stripe, trialSubscription)).toBe('first_paid')
    expect(finalizeInvoice).toHaveBeenCalledWith('in_1')
    expect(pay).toHaveBeenCalledWith('in_1', { off_session: true })
  })

  it('does not convert while the first invoice is unpaid', async () => {
    const { stripe, release } = fakeInvoiceStripe({ id: 'in_1', status: 'draft', billing_reason: 'subscription_create' }, 'declined')
    expect(await settleTrialPlanFirstInvoice(context, stripe, trialSubscription)).toBe('unpaid')
    expect(release).not.toHaveBeenCalled()
  })

  it('releases the schedule once paid so the subscription can be canceled normally', async () => {
    const { stripe, release } = fakeInvoiceStripe({ id: 'in_1', status: 'draft', billing_reason: 'subscription_create' }, 'paid')
    const scheduled = { ...trialSubscription, schedule: 'sub_sched_trial' } as unknown as Stripe.Subscription
    expect(await settleTrialPlanFirstInvoice(context, stripe, scheduled)).toBe('first_paid')
    expect(release).toHaveBeenCalledWith('sub_sched_trial')
  })

  it('never charges the first invoice once the live subscription is canceled', async () => {
    const { stripe, finalizeInvoice, pay } = fakeInvoiceStripe({ id: 'in_1', status: 'open', billing_reason: 'subscription_create' }, 'paid', 'canceled')
    expect(await settleTrialPlanFirstInvoice(context, stripe, trialSubscription)).toBe('unpaid')
    expect(finalizeInvoice).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('leaves renewals to the normal subscription flow', async () => {
    const { stripe, pay } = fakeInvoiceStripe({ id: 'in_1', status: 'open', billing_reason: 'subscription_cycle' }, 'declined')
    expect(await settleTrialPlanFirstInvoice(context, stripe, trialSubscription)).toBe('renewal')
    expect(pay).not.toHaveBeenCalled()
  })
})

describe('trial plan schedule release', () => {
  function stripeWithSchedule(metadata: Record<string, string>) {
    const release = vi.fn(async (id: string) => ({ id }))
    const stripe = {
      subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, schedule: 'sub_sched_1' })) },
      subscriptionSchedules: { retrieve: vi.fn(async (id: string) => ({ id, status: 'active', metadata })), release },
    } as unknown as Stripe
    return { stripe, release }
  }

  it('releases the trial plan schedule before cancel or resume', async () => {
    const { stripe, release } = stripeWithSchedule({ capgo_trial_plan: 'true' })
    await releaseTrialPlanSchedule(context, stripe, 'sub_1')
    expect(release).toHaveBeenCalledWith('sub_sched_1')
  })

  it('leaves other schedules and their future phases alone', async () => {
    const { stripe, release } = stripeWithSchedule({})
    await releaseTrialPlanSchedule(context, stripe, 'sub_1')
    expect(release).not.toHaveBeenCalled()
  })

  it('treats a schedule released concurrently as done', async () => {
    let released = false
    const release = vi.fn(async () => {
      released = true
      throw new Error('schedule already released')
    })
    const stripe = {
      subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, schedule: 'sub_sched_1' })) },
      subscriptionSchedules: {
        retrieve: vi.fn(async (id: string) => ({ id, status: released ? 'released' : 'active', metadata: { capgo_trial_plan: 'true' } })),
        release,
      },
    } as unknown as Stripe
    await expect(releaseTrialPlanSchedule(context, stripe, 'sub_1')).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledWith('sub_sched_1')
  })

  it('still fails when the schedule is active after a failed release', async () => {
    const stripe = {
      subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, schedule: 'sub_sched_1' })) },
      subscriptionSchedules: {
        retrieve: vi.fn(async (id: string) => ({ id, status: 'active', metadata: { capgo_trial_plan: 'true' } })),
        release: vi.fn(async () => {
          throw new Error('stripe down')
        }),
      },
    } as unknown as Stripe
    await expect(releaseTrialPlanSchedule(context, stripe, 'sub_1')).rejects.toThrow('stripe down')
  })
})

describe('never-paid trial plan', () => {
  function stripeWithInvoice(invoice: Partial<Stripe.Invoice>) {
    return { invoices: { retrieve: vi.fn(async () => invoice) } } as unknown as Stripe
  }

  it('flags a trial plan whose first invoice was never paid', async () => {
    expect(await isTrialPlanFirstInvoiceUnpaid(stripeWithInvoice({ billing_reason: 'subscription_create', status: 'uncollectible' }), trialSubscription)).toBe(true)
  })

  it('does not flag a paid first invoice, a renewal, or another subscription', async () => {
    expect(await isTrialPlanFirstInvoiceUnpaid(stripeWithInvoice({ billing_reason: 'subscription_create', status: 'paid' }), trialSubscription)).toBe(false)
    expect(await isTrialPlanFirstInvoiceUnpaid(stripeWithInvoice({ billing_reason: 'subscription_cycle', status: 'open' }), trialSubscription)).toBe(false)
    const other = { id: 'sub_2', latest_invoice: 'in_2', metadata: {} } as unknown as Stripe.Subscription
    expect(await isTrialPlanFirstInvoiceUnpaid(stripeWithInvoice({ billing_reason: 'subscription_create', status: 'open' }), other)).toBe(false)
  })
})

describe('pending schedule pagination', () => {
  it('reads every page before reporting pending schedules', async () => {
    const list = vi.fn(async (params: Stripe.SubscriptionScheduleListParams) => params.starting_after
      ? { data: [{ id: 'sub_sched_late', status: 'not_started', created: 1, metadata: { capgo_trial_plan: 'true' } }], has_more: false }
      : { data: [{ id: 'sub_sched_other', status: 'released', created: 2, metadata: {} }], has_more: true })
    const cancel = vi.fn(async (id: string) => ({ id }))
    const stripe = { subscriptionSchedules: { list, cancel } } as unknown as Stripe
    expect((await findPendingTrialPlanSchedule(stripe, 'cus_1'))?.id).toBe('sub_sched_late')
    expect(list).toHaveBeenNthCalledWith(2, { customer: 'cus_1', limit: 100, starting_after: 'sub_sched_other' })
  })
})

describe('cancel trial plan', () => {
  it('cancels the schedule even when price enrichment fails', async () => {
    const schedule = {
      id: 'sub_sched_trial',
      status: 'not_started',
      created: 1,
      metadata: { capgo_trial_plan: 'true' },
      phases: [{ start_date: 1_735_689_600, items: [{ price: 'price_1' }] }],
    }
    const cancel = vi.fn(async (id: string) => ({ id }))
    const list = vi.fn(async () => ({ data: [schedule], has_more: false }))
    const retrieve = vi.fn(async () => {
      throw new Error('stripe price unavailable')
    })
    const stripe = {
      subscriptionSchedules: { list, cancel },
      prices: { retrieve },
    } as unknown as Stripe
    const ctx = { stripe, customerId: 'cus_1' } as any
    const result = await cancelTrialPlan(context, ctx, 'org_1')
    expect(cancel).toHaveBeenCalledWith('sub_sched_trial')
    expect(retrieve).toHaveBeenCalled()
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(retrieve.mock.invocationCallOrder[0])
    expect(result).toEqual({
      planName: '',
      productId: '',
      amount: 0,
      currency: 'usd',
      interval: 'month',
      startsAt: '2025-01-01T00:00:00.000Z',
      scheduled: false,
    })
  })
})

describe('schedulable trial plans', () => {
  it('schedules the regional price the visitor qualifies for, else the full price', () => {
    const plan = { stripe_id: 'prod_solo', price_m_id: 'price_solo_m', price_y_id: 'price_solo_y', regional_price_ids: { p50: { price_m_id: 'price_solo_m_p50' } } }
    expect(getTrialPlanPriceId(plan, 'ee', 'p50')).toBe('price_solo_m_p50')
    expect(getTrialPlanPriceId(plan, 'ee', 'p70')).toBe('price_solo_m')
    expect(getTrialPlanPriceId({ ...plan, regional_price_ids: {} }, 'ee', 'p50')).toBe('price_solo_m')
  })

  it('charges the trial a regional price only in its region\'s currency, or USD where Stripe lacks it', async () => {
    const plans = [{ regional_price_ids: { p50: { price_m_id: 'price_solo_m_p50' }, p70: { price_m_id: 'price_solo_m_p70' } } }]
    adminRows.override = (text) => {
      expect(text).toContain('FROM public.plans WHERE name = ANY')
      return plans.map(row => ({ row }))
    }
    const tierFor = (country: string, currency: string | null) => {
      const stripe = {
        customers: { retrieve: vi.fn(async () => ({ id: 'cus_1', currency, address: null, invoice_settings: { default_payment_method: null } })) },
        prices: { retrieve: vi.fn(async (id: string) => ({ id, currency_options: { usd: {}, eur: {}, inr: {} } })) },
      } as unknown as Stripe
      const c = { get: () => 'request-id', req: { raw: { cf: { country } }, header: () => undefined } } as any
      return getTrialPriceTier(c, { stripe, customerId: 'cus_1', billingAccount: 'ee' } as any)
    }
    try {
      // No currency pinned yet: the schedule bills USD.
      await expect(tierFor('FR', null)).resolves.toBe('p100')
      await expect(tierFor('FR', 'eur')).resolves.toBe('p70')
      await expect(tierFor('IN', 'usd')).resolves.toBe('p100')
      // Stripe does not sell GHS: USD keeps the discount.
      await expect(tierFor('GH', null)).resolves.toBe('p50')
      await expect(tierFor('GH', 'eur')).resolves.toBe('p100')
    }
    finally {
      adminRows.override = null
    }
  })

  it('exposes Solo, Maker and Team for the plan picker', async () => {
    const { SCHEDULABLE_TRIAL_PLAN_NAMES } = await import('../supabase/functions/_backend/utils/stripe_trial_plan.ts')
    expect([...SCHEDULABLE_TRIAL_PLAN_NAMES]).toEqual(['Solo', 'Maker', 'Team'])
  })
})

describe('start trial plan now', () => {
  const input = {
    customerId: 'cus_1',
    orgId: 'org_1',
    priceId: 'price_solo',
    paymentMethodId: 'pm_1',
    automaticTax: true,
    metadata: { affonso_referral: 'ref_example' },
  }

  it('charges the first invoice now and marks the subscription as a trial plan started now', async () => {
    const create = vi.fn(async () => ({ id: 'sub_now', created: 1 }))
    const stripe = { subscriptions: { create, list: vi.fn(async () => ({ data: [] })) } } as unknown as Stripe
    await createStartNowSubscription(stripe, input)
    expect(create).toHaveBeenCalledWith({
      customer: 'cus_1',
      items: [{ price: 'price_solo', quantity: 1 }],
      default_payment_method: 'pm_1',
      collection_method: 'charge_automatically',
      payment_behavior: 'error_if_incomplete',
      automatic_tax: { enabled: true },
      metadata: { affonso_referral: 'ref_example', org_id: 'org_1', capgo_trial_plan: 'true', capgo_trial_started_now: 'true' },
    })
  })

  it('returns the started-now subscription instead of charging again', async () => {
    const live = { id: 'sub_now', status: 'active', metadata: { capgo_trial_plan: 'true', capgo_trial_started_now: 'true' } }
    const create = vi.fn()
    const list = vi.fn(async () => ({ data: [{ id: 'sub_old', status: 'canceled', metadata: {} }, live] }))
    const stripe = { subscriptions: { create, list } } as unknown as Stripe
    await expect(createStartNowSubscription(stripe, { ...input, paymentMethodId: 'pm_other' })).resolves.toEqual({ subscription: live, reused: true })
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 })
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses to start now when another subscription is live', async () => {
    const create = vi.fn()
    const list = vi.fn(async () => ({ data: [{ id: 'sub_checkout', status: 'past_due', metadata: {} }] }))
    const stripe = { subscriptions: { create, list } } as unknown as Stripe
    await expect(createStartNowSubscription(stripe, input)).rejects.toMatchObject({ cause: { error: 'trial_plan_already_subscribed' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('lets a declined card be retried instead of replaying the decline', async () => {
    const create = vi.fn(async () => ({ id: 'sub_now', created: 1 }))
    const stripe = { subscriptions: { create, list: vi.fn(async () => ({ data: [] })) } } as unknown as Stripe
    await createStartNowSubscription(stripe, input)
    expect(create.mock.calls[0]).toHaveLength(1)
  })

  it('reports a declined card without leaving a subscription behind', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', statusCode: 402, code: 'card_declined' })
    })
    const stripe = { subscriptions: { create, list: vi.fn(async () => ({ data: [] })) } } as unknown as Stripe
    await expect(createStartNowSubscription(stripe, input)).rejects.toMatchObject({
      status: 400,
      cause: { error: 'trial_plan_payment_failed', moreInfo: { code: 'card_declined' } },
    })
  })

  it('rethrows other Stripe failures', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError', statusCode: 429 })
    })
    const stripe = { subscriptions: { create, list: vi.fn(async () => ({ data: [] })) } } as unknown as Stripe
    await expect(createStartNowSubscription(stripe, input)).rejects.toThrow('rate limited')
  })
})

describe('trial plan lock', () => {
  function fakeLockClient(failOn?: string) {
    const queries: string[] = []
    const query = vi.fn(async (text: string) => {
      queries.push(text)
      if (failOn && text.startsWith(failOn))
        throw new Error('connection terminated')
      return { rows: [] }
    })
    return { client: { query }, queries }
  }

  it('locks per customer and keeps the transaction busy while Stripe is slow', async () => {
    vi.useFakeTimers()
    try {
      const { client, queries } = fakeLockClient()
      const run = vi.fn(() => new Promise<string>(resolve => setTimeout(() => resolve('sub_now'), 40_000)))
      const held = holdTrialPlanLock(context, client, 'cus_1', run, 5_000)
      await vi.advanceTimersByTimeAsync(40_000)
      await expect(held).resolves.toEqual({ result: 'sub_now', connectionLost: false })
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['trial_plan:cus_1'])
      expect(queries.filter(text => text === 'SELECT 1').length).toBeGreaterThanOrEqual(7)
      expect(queries.at(-1)).toBe('COMMIT')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('returns the Stripe result when a heartbeat finds the connection lost', async () => {
    vi.useFakeTimers()
    try {
      const { client, queries } = fakeLockClient('SELECT 1')
      const run = vi.fn(() => new Promise<string>(resolve => setTimeout(() => resolve('sub_now'), 20_000)))
      const held = holdTrialPlanLock(context, client, 'cus_1', run, 5_000)
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(held).resolves.toEqual({ result: 'sub_now', connectionLost: true })
      // The heartbeat stops after the first failure.
      expect(queries.filter(text => text === 'SELECT 1')).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('bounds the lock transaction with the idle timeout', async () => {
    const { client, queries } = fakeLockClient()
    await holdTrialPlanLock(context, client, 'cus_1', async () => 'sub_now')
    expect(queries[0]).toMatch(/^BEGIN READ WRITE; SET LOCAL statement_timeout = \d+; SET LOCAL idle_in_transaction_session_timeout = \d+$/)
  })

  it('returns the Stripe result when the connection drops before COMMIT', async () => {
    const { client } = fakeLockClient('COMMIT')
    await expect(holdTrialPlanLock(context, client, 'cus_1', async () => 'sub_now')).resolves.toEqual({ result: 'sub_now', connectionLost: true })
  })

  it('rolls back and rethrows when the guarded call fails', async () => {
    const { client, queries } = fakeLockClient()
    await expect(holdTrialPlanLock(context, client, 'cus_1', async () => {
      throw new Error('card_declined')
    })).rejects.toThrow('card_declined')
    expect(queries.at(-1)).toBe('ROLLBACK')
  })
})

describe('sync pending trial plan schedule with trial end', () => {
  const oldStartUnix = Math.floor(Date.parse('2026-10-30T00:00:00.000Z') / 1000)
  const newTrialAt = '2026-11-14T09:30:00.000Z'
  const newStartUnix = Math.floor(Date.parse('2026-11-14T00:00:00.000Z') / 1000)

  function pendingSchedule(startUnix = oldStartUnix) {
    return {
      id: 'sub_sched_trial',
      status: 'not_started',
      created: 1,
      metadata: { capgo_trial_plan: 'true', org_id: 'org_1' },
      phases: [{ start_date: startUnix, items: [{ price: 'price_solo_m' }], metadata: { capgo_trial_plan: 'true', org_id: 'org_1' } }],
    } as unknown as Stripe.SubscriptionSchedule
  }

  it('moves the schedule start when the trial is extended after picking a plan', async () => {
    const update = vi.fn(async () => pendingSchedule(newStartUnix))
    const list = vi.fn(async () => ({ data: [pendingSchedule()], has_more: false }))
    const stripe = { subscriptionSchedules: { list, update } } as unknown as Stripe
    stripeClientMock.stripe = stripe
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', newTrialAt)).toBe('updated')
    expect(update).toHaveBeenCalledWith('sub_sched_trial', {
      phases: [{
        items: [{ price: 'price_solo_m', quantity: 1 }],
        start_date: newStartUnix,
        metadata: { capgo_trial_plan: 'true', org_id: 'org_1' },
      }],
    })
  })

  it('schedules at the extended trial end when the org picks a plan after an extension', () => {
    const now = Date.parse('2026-10-21T12:00:00.000Z')
    expect(getTrialPlanStartDate(newTrialAt, now)?.toISOString()).toBe('2026-11-14T00:00:00.000Z')
  })

  it('routes Stripe calls through the customer billing account', async () => {
    billingAccountMock.account = 'us'
    stripeClientMock.lastAccount = null
    const list = vi.fn(async () => ({ data: [], has_more: false }))
    stripeClientMock.stripe = { subscriptionSchedules: { list } } as unknown as Stripe
    await syncTrialPlanScheduleForCustomer(context, 'cus_us', newTrialAt)
    expect(stripeClientMock.lastAccount).toBe('us')
    billingAccountMock.account = 'ee'
    stripeClientMock.lastAccount = null
    await syncTrialPlanScheduleForCustomer(context, 'cus_ee', newTrialAt)
    expect(stripeClientMock.lastAccount).toBe('ee')
  })

  it('returns failed without throwing when Stripe rejects the schedule update', async () => {
    const list = vi.fn(async () => ({ data: [pendingSchedule()], has_more: false }))
    const update = vi.fn(async () => {
      throw new Error('stripe unavailable')
    })
    const stripe = { subscriptionSchedules: { list, update } } as unknown as Stripe
    stripeClientMock.stripe = stripe
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', newTrialAt)).toBe('failed')
    expect(update).toHaveBeenCalled()
  })

  it('leaves the schedule unchanged when the start already matches the trial end', async () => {
    const list = vi.fn(async () => ({ data: [pendingSchedule(newStartUnix)], has_more: false }))
    const update = vi.fn()
    const stripe = { subscriptionSchedules: { list, update } } as unknown as Stripe
    stripeClientMock.stripe = stripe
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', newTrialAt)).toBe('unchanged')
    expect(update).not.toHaveBeenCalled()
  })

  it('cancels the pending schedule when the trial end is missing or past', async () => {
    const cancel = vi.fn(async (id: string) => ({ id }))
    const list = vi.fn(async () => ({ data: [pendingSchedule()], has_more: false }))
    const stripe = { subscriptionSchedules: { list, cancel } } as unknown as Stripe
    stripeClientMock.stripe = stripe
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', null)).toBe('canceled')
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', '2020-01-01T00:00:00.000Z')).toBe('canceled')
    expect(cancel).toHaveBeenCalledWith('sub_sched_trial')
  })

  it('cancels duplicate pending schedules after moving the kept schedule', async () => {
    const duplicate = {
      ...pendingSchedule(),
      id: 'sub_sched_dup',
      created: 2,
    } as unknown as Stripe.SubscriptionSchedule
    const update = vi.fn(async () => pendingSchedule(newStartUnix))
    const cancel = vi.fn(async (id: string) => ({ id }))
    const list = vi.fn(async () => ({ data: [pendingSchedule(), duplicate], has_more: false }))
    const stripe = { subscriptionSchedules: { list, update, cancel } } as unknown as Stripe
    stripeClientMock.stripe = stripe
    expect(await syncPendingTrialPlanScheduleWithTrialAt(context, stripe, 'cus_1', newTrialAt)).toBe('updated')
    expect(update).toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith('sub_sched_dup')
    expect(cancel).not.toHaveBeenCalledWith('sub_sched_trial')
  })
})
