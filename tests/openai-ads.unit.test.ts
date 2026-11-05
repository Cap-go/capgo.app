import type { Context } from 'hono'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildOpenAIRegistrationEvent, buildOpenAISubscriptionEvent, getOpenAISubscriptionSourceUrl, normalizeOpenAICurrency, normalizeOpenAIName, trackOpenAIRegistration, trackOpenAISubscription } from '../supabase/functions/_backend/utils/openai_ads.ts'
import { getInvoicePayment, getOpenAIFirstPaymentAt, isFirstSubscriptionInvoicePaid, isIncompleteSubscriptionActivation, trackOpenAIFirstPayment } from '../supabase/functions/_backend/utils/openai_ads_first_payment.ts'

const envValues: Record<string, string> = {}

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: (error: unknown) => error,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => envValues[key] ?? '',
}))

function createContext() {
  return { get: vi.fn(() => 'request-id') } as unknown as Context
}

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const now = Date.parse('2026-10-19T12:00:00.000Z')
const record = {
  id: ' 6aa76066-55ef-4238-ade6-0b32334a4097 ',
  email: '  John.Doe@Example.com ',
  first_name: 'Mary Jane',
  last_name: 'O\'Connor',
  country: 'fr',
  created_at: '2026-10-19T11:59:00.000Z',
}

describe('openai ads conversions api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of Object.keys(envValues))
      delete envValues[key]
  })

  it('normalizes names like the spec', () => {
    expect(normalizeOpenAIName('Mary Jane')).toBe('maryjane')
    expect(normalizeOpenAIName('O\'Connor')).toBe('oconnor')
    expect(normalizeOpenAIName('José')).toBe('josé')
  })

  it('builds a registration event matching the pixel event id and hashed user data', async () => {
    const userIdHash = sha('6aa76066-55ef-4238-ade6-0b32334a4097')
    expect(await buildOpenAIRegistrationEvent(record, now)).toEqual({
      id: `registration_${userIdHash}`,
      type: 'registration_completed',
      timestamp_ms: Date.parse(record.created_at),
      source_url: 'https://capgo.app/register/',
      action_source: 'web',
      user: {
        external_ids_sha256: [userIdHash],
        emails_sha256: [sha('john.doe@example.com')],
        first_names_sha256: [sha('maryjane')],
        last_names_sha256: [sha('oconnor')],
        countries: ['FR'],
      },
      data: { type: 'customer_action' },
    })
  })

  it('does nothing without OPENAI_ADS_API_KEY', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await trackOpenAIRegistration(createContext(), record)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to the Conversions API with bearer auth and pixel id', async () => {
    envValues.OPENAI_ADS_API_KEY = 'test-key'
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await trackOpenAIRegistration(createContext(), record)).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://bzr.openai.com/v1/events?pid=5Fiq7Kwp18THe1MThKS7GL')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].type).toBe('registration_completed')
  })

  it('skips registrations with an unknown creation time', async () => {
    envValues.OPENAI_ADS_API_KEY = 'test-key'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await buildOpenAIRegistrationEvent({ ...record, created_at: null }, now)).toBeNull()
    expect(await buildOpenAIRegistrationEvent({ ...record, created_at: 'not a date' }, now)).toBeNull()
    expect(await trackOpenAIRegistration(createContext(), { ...record, created_at: null })).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries transient failures with the same event id', async () => {
    envValues.OPENAI_ADS_API_KEY = 'test-key'
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await trackOpenAIRegistration(createContext(), record, { retryDelaysMs: [0, 0] })).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const ids = fetchMock.mock.calls.map(call => JSON.parse((call[1] as RequestInit).body as string).events[0].id)
    expect(new Set(ids).size).toBe(1)
  })

  it('does not retry client errors and stops after the last attempt', async () => {
    envValues.OPENAI_ADS_API_KEY = 'test-key'
    vi.useFakeTimers({ now, toFake: ['Date'] })
    try {
      const badRequest = vi.fn(async () => new Response('bad', { status: 400 }))
      vi.stubGlobal('fetch', badRequest)
      expect(await trackOpenAIRegistration(createContext(), record, { retryDelaysMs: [0, 0] })).toBe(false)
      expect(badRequest).toHaveBeenCalledTimes(1)

      const alwaysDown = vi.fn(async () => {
        throw new Error('network down')
      })
      vi.stubGlobal('fetch', alwaysDown)
      expect(await trackOpenAIRegistration(createContext(), record, { retryDelaysMs: [0, 0] })).toBe(false)
      expect(alwaysDown).toHaveBeenCalledTimes(3)
    }
    finally {
      vi.useRealTimers()
    }
  })

  describe('subscription_created (first payment)', () => {
    const orgId = '0f2c1a3b-1111-4222-8333-444455556666'
    const paidAt = '2026-10-19T11:30:00.000Z'
    const input = {
      orgId,
      user: record,
      paidAt,
      planId: 'Solo',
      amount: 1400,
      currency: 'usd',
      sourceUrl: 'https://console.capgo.app/settings/organization/plans',
    }

    it('falls back to the website as source url', async () => {
      expect((await buildOpenAISubscriptionEvent({ ...input, sourceUrl: null }, now))!.source_url).toBe('https://capgo.app/')
    })

    it('builds a plan_enrollment event with a per-org id and the registration user hashes', async () => {
      const userIdHash = sha('6aa76066-55ef-4238-ade6-0b32334a4097')
      const registration = await buildOpenAIRegistrationEvent(record, now)
      const event = await buildOpenAISubscriptionEvent(input, now)
      expect(event).toEqual({
        id: `subscription_${sha(orgId)}`,
        type: 'subscription_created',
        timestamp_ms: Date.parse(paidAt),
        source_url: 'https://console.capgo.app/settings/organization/plans',
        action_source: 'web',
        user: registration!.user,
        data: { type: 'plan_enrollment', plan_id: 'Solo', amount: 1400, currency: 'USD' },
      })
      expect(event!.user.external_ids_sha256).toEqual([userIdHash])
    })

    it('maps amount and currency: both or neither, integer minor units, uppercase ISO code', async () => {
      const data = async (overrides: Record<string, unknown>) => (await buildOpenAISubscriptionEvent({ ...input, ...overrides }, now))!.data
      expect(await data({ amount: 0, currency: 'eur' })).toEqual({ type: 'plan_enrollment', plan_id: 'Solo', amount: 0, currency: 'EUR' })
      expect(await data({ amount: 1400, currency: null })).toEqual({ type: 'plan_enrollment', plan_id: 'Solo' })
      expect(await data({ amount: undefined, currency: 'usd' })).toEqual({ type: 'plan_enrollment', plan_id: 'Solo' })
      expect(await data({ amount: 14.5 })).toEqual({ type: 'plan_enrollment', plan_id: 'Solo' })
      expect(await data({ amount: -1 })).toEqual({ type: 'plan_enrollment', plan_id: 'Solo' })
      expect(await data({ planId: '' })).toEqual({ type: 'plan_enrollment', amount: 1400, currency: 'USD' })
      expect(normalizeOpenAICurrency(' jpy ')).toBe('JPY')
      expect(normalizeOpenAICurrency('dollars')).toBeNull()
    })

    it('reads the amount actually paid from a paid invoice only', () => {
      expect(getInvoicePayment({ status: 'paid', amount_paid: 11880, currency: 'usd' })).toEqual({ amount: 11880, currency: 'USD' })
      expect(getInvoicePayment({ status: 'open', amount_paid: 0, currency: 'usd' })).toBeNull()
      // A promotion code covering the first period: a real enrollment, worth 0.
      expect(getInvoicePayment({ status: 'paid', amount_paid: 0, currency: 'usd' })).toEqual({ amount: 0, currency: 'USD' })
      expect(getInvoicePayment(null)).toBeNull()
    })

    it('reports a first payment once, and recovers one first recorded by an incomplete subscription', () => {
      const eventOccurredAtIso = '2026-10-19T11:45:00.000Z'
      const activation = { type: 'customer.subscription.updated', data: { object: { status: 'active' }, previous_attributes: { status: 'incomplete' } } } as any
      const renewal = { type: 'customer.subscription.updated', data: { object: { status: 'active' }, previous_attributes: { items: {} } } } as any
      expect(isIncompleteSubscriptionActivation(activation)).toBe(true)
      expect(isIncompleteSubscriptionActivation(renewal)).toBe(false)
      expect(isIncompleteSubscriptionActivation({ ...activation, type: 'customer.subscription.created' })).toBe(false)
      // A Stripe trial that converts: its first real invoice was just paid.
      const trialConverted = { type: 'customer.subscription.updated', data: { object: { status: 'active' }, previous_attributes: { status: 'trialing' } } } as any
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-10-01T00:00:00.000Z', stripeEvent: trialConverted, eventOccurredAtIso, now })).toBe(eventOccurredAtIso)
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-06-01T00:00:00.000Z', stripeEvent: trialConverted, eventOccurredAtIso, now })).toBeNull()
      // An incomplete subscription is paid or expires within a day: a 2-week-old paid_at is another subscription.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-10-01T00:00:00.000Z', stripeEvent: activation, eventOccurredAtIso, now })).toBeNull()
      // paid_at moved from null to set in this webhook.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: paidAt, currentPaidAt: null, stripeEvent: renewal, eventOccurredAtIso, now })).toBe(paidAt)
      // Renewals and retries: paid_at already set, nothing to report.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: paidAt, stripeEvent: renewal, eventOccurredAtIso, now })).toBeNull()
      // The incomplete subscription that set paid_at is now paid.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: paidAt, stripeEvent: activation, eventOccurredAtIso, now })).toBe(eventOccurredAtIso)
      // An org that first paid long ago is not a new conversion.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-01-01T00:00:00.000Z', stripeEvent: activation, eventOccurredAtIso, now })).toBeNull()
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: null, stripeEvent: activation, eventOccurredAtIso, now })).toBeNull()
    })

    it('recovers an invoiced (send_invoice) subscription whose first invoice is paid later', async () => {
      const eventOccurredAtIso = '2026-10-19T11:50:00.000Z'
      const invoice = { id: 'in_transfer', status: 'paid', billing_reason: 'subscription_create', collection_method: 'send_invoice' }
      const invoiceUpdated = { type: 'invoice.updated', data: { object: invoice, previous_attributes: { status: 'open' } } } as any
      expect(isFirstSubscriptionInvoicePaid(invoiceUpdated)).toBe(true)
      expect(isFirstSubscriptionInvoicePaid({ type: 'invoice.paid', data: { object: invoice } } as any)).toBe(false)
      // Not a payment transition, a renewal, or a card subscription (handled by the subscription webhooks).
      expect(isFirstSubscriptionInvoicePaid({ ...invoiceUpdated, data: { object: invoice, previous_attributes: { footer: 'x' } } })).toBe(false)
      expect(isFirstSubscriptionInvoicePaid({ ...invoiceUpdated, data: { ...invoiceUpdated.data, object: { ...invoice, billing_reason: 'subscription_cycle' } } })).toBe(false)
      expect(isFirstSubscriptionInvoicePaid({ ...invoiceUpdated, data: { ...invoiceUpdated.data, object: { ...invoice, collection_method: 'charge_automatically' } } })).toBe(false)
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: paidAt, stripeEvent: invoiceUpdated, eventOccurredAtIso, now })).toBe(eventOccurredAtIso)
      // Payment terms: the invoice can be paid weeks after the subscription set paid_at.
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-09-25T00:00:00.000Z', stripeEvent: invoiceUpdated, eventOccurredAtIso, now })).toBe(eventOccurredAtIso)
      expect(getOpenAIFirstPaymentAt({ firstPaidAt: null, currentPaidAt: '2026-06-01T00:00:00.000Z', stripeEvent: invoiceUpdated, eventOccurredAtIso, now })).toBeNull()

      envValues.OPENAI_ADS_API_KEY = 'test-key'
      vi.useFakeTimers({ now, toFake: ['Date'] })
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const retrieveInvoice = vi.fn(async () => ({ status: 'paid' as const, amount_paid: 11880, currency: 'eur' }))
      try {
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt: eventOccurredAtIso, planId: 'Team', stripeEvent: invoiceUpdated }, { loadUser: async () => record, retrieveInvoice })).toBe(true)
      }
      finally {
        vi.useRealTimers()
      }
      expect(retrieveInvoice).toHaveBeenCalledWith('in_transfer')
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).events[0]).toMatchObject({
        id: `subscription_${sha(orgId)}`,
        data: { type: 'plan_enrollment', plan_id: 'Team', amount: 11880, currency: 'EUR' },
      })
    })

    it('reports the first payment confirmed by invoice.paid (settled ACH debit)', async () => {
      const paidAtIso = '2026-10-19T12:00:00.000Z'
      const invoicePaid = { type: 'invoice.paid', data: { object: { id: 'in_ach', status: 'paid' } } } as any
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      vi.useFakeTimers({ now, toFake: ['Date'] })
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const retrieveInvoice = vi.fn(async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }))
      try {
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt: paidAtIso, planId: 'Solo', stripeEvent: invoicePaid }, { loadUser: async () => record, retrieveInvoice })).toBe(true)
      }
      finally {
        vi.useRealTimers()
      }
      expect(retrieveInvoice).toHaveBeenCalledWith('in_ach')
    })

    it('uses the console plans page as source url', () => {
      envValues.WEBAPP_URL = 'https://console.capgo.app/'
      expect(getOpenAISubscriptionSourceUrl(createContext())).toBe('https://console.capgo.app/settings/organization/plans')
      envValues.WEBAPP_URL = 'http://localhost:5173'
      expect(getOpenAISubscriptionSourceUrl(createContext())).toBe('https://capgo.app/')
      delete envValues.WEBAPP_URL
      expect(getOpenAISubscriptionSourceUrl(createContext())).toBe('https://capgo.app/')
    })

    it('does nothing without OPENAI_ADS_API_KEY, not even lookups', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const loadUser = vi.fn()
      const retrieveInvoice = vi.fn()
      expect(await trackOpenAISubscription(createContext(), input)).toBe(false)
      expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent: null }, { loadUser, retrieveInvoice })).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(loadUser).not.toHaveBeenCalled()
      expect(retrieveInvoice).not.toHaveBeenCalled()
    })

    it('skips first payments older than 7 days', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      vi.useFakeTimers({ now, toFake: ['Date'] })
      try {
        expect(await trackOpenAISubscription(createContext(), { ...input, paidAt: '2026-10-11T12:00:00.000Z' })).toBe(false)
      }
      finally {
        vi.useRealTimers()
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends the first payment with the invoice amount and retries with the same id', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      envValues.WEBAPP_URL = 'https://console.capgo.app'
      vi.useFakeTimers({ now, toFake: ['Date'] })
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const retrieveInvoice = vi.fn(async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }))
      const stripeEvent = { type: 'customer.subscription.created', data: { object: { latest_invoice: 'in_first' } } } as any
      try {
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => record,
          retrieveInvoice,
          retryDelaysMs: [0],
        })).toBe(true)
      }
      finally {
        vi.useRealTimers()
      }
      expect(retrieveInvoice).toHaveBeenCalledWith('in_first')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const events = fetchMock.mock.calls.map(call => JSON.parse((call[1] as RequestInit).body as string).events[0])
      expect(new Set(events.map(event => event.id))).toEqual(new Set([`subscription_${sha(orgId)}`]))
      expect(events[0]).toMatchObject({
        type: 'subscription_created',
        timestamp_ms: Date.parse(paidAt),
        source_url: 'https://console.capgo.app/settings/organization/plans',
        data: { type: 'plan_enrollment', plan_id: 'Solo', amount: 1400, currency: 'USD' },
      })
    })

    it('never reports without proof of payment, and never throws', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      vi.useFakeTimers({ now, toFake: ['Date'] })
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const stripeEvent = { type: 'customer.subscription.updated', data: { object: { latest_invoice: 'in_first' } } } as any
      try {
        const stripeDown = vi.fn(async () => { throw new Error('stripe down') })
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => record,
          retrieveInvoice: stripeDown,
          invoiceRetryDelaysMs: [0, 0],
        })).toBe(false)
        expect(stripeDown).toHaveBeenCalledTimes(3)
        // An incomplete subscription: paid_at is set but the invoice is still open.
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => record,
          retrieveInvoice: async () => ({ status: 'open' as const, amount_paid: 0, currency: 'usd' }),
        })).toBe(false)
        // A Stripe trial's $0 invoice is not a payment.
        const trialing = { type: 'customer.subscription.created', data: { object: { status: 'trialing', latest_invoice: 'in_trial' } } } as any
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent: trialing }, {
          loadUser: async () => record,
          retrieveInvoice: async () => ({ status: 'paid' as const, amount_paid: 0, currency: 'usd' }),
        })).toBe(false)
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent: null }, {
          loadUser: async () => record,
          retrieveInvoice: async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }),
        })).toBe(false)

        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => { throw new Error('db down') },
          retrieveInvoice: async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }),
        })).toBe(false)
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => null,
          retrieveInvoice: async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }),
        })).toBe(false)
      }
      finally {
        vi.useRealTimers()
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('retries a transient invoice lookup failure before giving up', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      vi.useFakeTimers({ now, toFake: ['Date'] })
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const retrieveInvoice = vi.fn()
        .mockRejectedValueOnce(new Error('stripe blip'))
        .mockResolvedValueOnce({ status: 'paid', amount_paid: 1400, currency: 'usd' })
      const stripeEvent = { type: 'customer.subscription.created', data: { object: { status: 'active', latest_invoice: 'in_first' } } } as any
      try {
        expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt, planId: 'Solo', stripeEvent }, {
          loadUser: async () => record,
          retrieveInvoice,
          invoiceRetryDelaysMs: [0, 0],
        })).toBe(true)
      }
      finally {
        vi.useRealTimers()
      }
      expect(retrieveInvoice).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('shares one deadline between the invoice lookup and the send', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const stripeEvent = { type: 'customer.subscription.created', data: { object: { status: 'active', latest_invoice: 'in_first' } } } as any
      // The lookup used up the budget: no send starts after the deadline.
      expect(await trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt: new Date().toISOString(), planId: 'Solo', stripeEvent }, {
        loadUser: async () => record,
        retrieveInvoice: async () => {
          await new Promise(resolve => setTimeout(resolve, 30))
          return { status: 'paid' as const, amount_paid: 1400, currency: 'usd' }
        },
        budgetMs: 20,
      })).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('bounds the owner lookup inside the shared budget', async () => {
      envValues.OPENAI_ADS_API_KEY = 'test-key'
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const stripeEvent = { type: 'customer.subscription.created', data: { object: { status: 'active', latest_invoice: 'in_first' } } } as any
      try {
        const result = trackOpenAIFirstPayment(createContext(), { orgId, ownerUserId: record.id, paidAt: new Date().toISOString(), planId: 'Solo', stripeEvent }, {
          loadUser: () => new Promise(() => {}),
          retrieveInvoice: async () => ({ status: 'paid' as const, amount_paid: 1400, currency: 'usd' }),
        })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(await result).toBe(false)
      }
      finally {
        vi.useRealTimers()
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
