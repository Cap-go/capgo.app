import type { BillingAccount } from '../supabase/functions/_backend/utils/stripe_billing.ts'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { app as eeApp } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { app as usApp } from '../supabase/functions/_backend/triggers/stripe_event_us.ts'

const mocks = vi.hoisted(() => ({
  table: vi.fn(),
  query: vi.fn(),
  getStripe: vi.fn(),
  invoicePayments: vi.fn(),
  openInvoice: vi.fn(),
  retrieve: vi.fn(),
  syncCountry: vi.fn(),
  ensureMetadata: vi.fn(),
  memberEmails: vi.fn(async () => ({ emails: ['owner@example.com', 'admin@example.com'], resolutionFailed: false })),
  orgUpdates: vi.fn(),
  fetch: vi.fn(),
  log: vi.fn(),
}))

vi.mock('hono/adapter', async importOriginal => ({
  ...await importOriginal<typeof import('hono/adapter')>(),
  env: (c: { env: Record<string, string> }) => c.env,
}))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/stripe.ts')>(),
  getStripe: mocks.getStripe,
  syncStripeCustomerCountry: mocks.syncCountry,
  ensureCustomerMetadata: mocks.ensureMetadata,
  getLatestOpenSubscriptionInvoice: mocks.openInvoice,
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  closeClient: () => undefined,
  getPgClient: async () => ({ query: mocks.query }),
}))
// pg.ts is part of an import cycle, so modules loaded while it initializes keep the real
// getPgClient; route RLS-context queries to the same fake explicitly.
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>(),
  withRlsContext: async (_c: unknown, _principal: unknown, run: (client: unknown, drizzle: unknown) => unknown) => run({ query: mocks.query }, null),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlog: mocks.log,
  cloudlogErr: mocks.log,
}))
vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/org_email_notifications.ts')>(),
  getOrgAdminMemberEmailsForTags: mocks.memberEmails,
}))

const stripe = new Stripe('sk_test_synthetic')
const org = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Synthetic organization',
  created_by: '22222222-2222-4222-8222-222222222222',
  management_email: 'billing@example.com',
  customer_id: 'cus_synthetic_trial',
  has_usage_credits: true,
}

function environment(): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: 'sk_test_synthetic_ee',
    STRIPE_SECRET_KEY_US: 'sk_test_synthetic_us',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_ee',
    STRIPE_WEBHOOK_SECRET_US: 'whsec_synthetic_us',
    BENTO_PUBLISHABLE_KEY: 'synthetic_publishable',
    BENTO_SECRET_KEY: 'synthetic_secret',
    BENTO_SITE_UUID: 'synthetic_site',
    WEBAPP_URL: 'https://console.example.com',
  }
}

function customerEvent(type: 'customer.created' | 'customer.updated' = 'customer.created') {
  return {
    id: 'evt_synthetic_trial',
    object: 'event',
    type,
    created: 1_760_000_000,
    data: {
      object: {
        id: org.customer_id,
        object: 'customer',
        created: 1_760_000_000,
        email: ' Billing@Example.com ',
        metadata: { org_id: org.id },
      },
    },
  }
}

function database(account: BillingAccount, linked = true, storedAccount: BillingAccount = account) {
  mocks.query.mockImplementation(async (text: string, values: unknown[] = []) => {
    const table = /(?:FROM|UPDATE|INTO)\s+public\.(\w+)/.exec(text)?.[1]
    if (!table)
      return { rows: [] }
    mocks.table(table)
    let rows: unknown[] = []
    if (table === 'orgs' && text.includes('UPDATE')) {
      mocks.orgUpdates({ management_email: values[0] })
      rows = [{ id: org.id }]
    }
    else if (table === 'orgs') {
      rows = linked ? [org] : []
    }
    else if (table === 'stripe_info' && text.includes('SELECT billing_account')) {
      rows = [{ billing_account: storedAccount }]
    }
    else if (table === 'stripe_info' && text.includes('SELECT *')) {
      rows = [{ customer_id: org.customer_id, billing_account: storedAccount }]
    }
    return { rows: text.includes('to_json(q.*)') ? rows.map(row => ({ row })) : rows }
  })
}

async function deliver(
  account: BillingAccount,
  event: unknown = customerEvent(),
  options: { env?: Record<string, string>, signature?: string | null, worker?: boolean } = {},
) {
  const body = JSON.stringify(event)
  const env = options.env ?? environment()
  const secret = account === 'ee' ? env.STRIPE_WEBHOOK_SECRET : env.STRIPE_WEBHOOK_SECRET_US
  const signature = options.signature === undefined
    ? stripe.webhooks.generateTestHeaderString({ payload: body, secret })
    : options.signature
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature !== null)
    headers.set('stripe-signature', signature)
  const path = options.worker ? `/triggers/stripe_event${account === 'us' ? '_us' : ''}/` : '/'
  const request = new Request(`https://api.example.com${path}`, { method: 'POST', headers, body })
  return options.worker
    ? apiWorker.fetch(request, env as never)
    : (account === 'ee' ? eeApp : usApp).fetch(request, env as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetch.mockImplementation(async () => Response.json({ results: 1, failed: 0 }))
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.retrieve.mockResolvedValue({ id: org.customer_id, object: 'customer', email: org.management_email })
  mocks.invoicePayments.mockResolvedValue({ data: [{ invoice: { id: 'in_synthetic', billing_reason: 'subscription_cycle', status: 'draft' } }] })
  mocks.openInvoice.mockResolvedValue({ amount_due: 9900, currency: 'usd', attempt_count: 1, next_payment_attempt: null })
  mocks.getStripe.mockReturnValue({ webhooks: stripe.webhooks, customers: { retrieve: mocks.retrieve }, invoicePayments: { list: mocks.invoicePayments } })
  database('ee')
})
afterEach(() => vi.unstubAllGlobals())

function chargeEvent(type: 'charge.failed' | 'charge.succeeded' = 'charge.failed') {
  return {
    id: 'evt_synthetic_charge',
    object: 'event',
    type,
    created: 1_760_000_000,
    data: { object: {
      id: 'ch_synthetic',
      object: 'charge',
      customer: org.customer_id,
      payment_intent: 'pi_synthetic',
    } },
  }
}

describe.each(['ee', 'us'] as const)('%s billing notifications', (account) => {
  beforeEach(() => database(account))

  it('alerts every billing recipient even when the org has usage credits', async () => {
    const response = await deliver(account, chargeEvent())
    expect(response.status).toBe(200)
    const events = mocks.fetch.mock.calls.flatMap(([, init]) => JSON.parse(init.body).events)
    expect(events.map(event => event.email).sort()).toEqual(['admin@example.com', 'billing@example.com', 'owner@example.com'])
    expect(events.every(event => event.type === 'org:failed_payment')).toBe(true)
    expect(events[0].details).toMatchObject({
      billing_url: `https://console.example.com/settings/organization/billing?oid=${org.id}`,
      org_id: org.id,
      billing_account: account,
      stripe_event_id: 'evt_synthetic_charge',
      amount: 99,
      currency: 'usd',
    })
    expect(mocks.openInvoice).toHaveBeenCalledWith(expect.anything(), org.customer_id, account)
    expect(mocks.getStripe.mock.calls.every(([, selected]) => selected === account)).toBe(true)
  })

  it.each([
    ['HTTP failure', () => new Response('', { status: 503 })],
    ['rejected event', () => Response.json({ results: 0, failed: 1 })],
    ['ambiguous response', () => Response.json({})],
    ['network failure', () => { throw new Error('network failure') }],
  ])('fails the webhook on %s so Stripe retries', async (_label, result) => {
    mocks.fetch.mockImplementation(async () => result())
    expect((await deliver(account, chargeEvent())).status).toBe(503)
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE public.stripe_info SET'))).toBe(true)
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'trackBillingBentoEvent' }))
  })

  it('does not report success when only some recipients were accepted', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ results: 0, failed: 1 }))
    expect((await deliver(account, chargeEvent())).status).toBe(503)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('accepts a retry once Bento recovers', async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ results: 0, failed: 1 }))
    expect((await deliver(account, chargeEvent())).status).toBe(503)
    mocks.fetch.mockImplementation(async () => Response.json({ results: 1, failed: 0 }))
    expect((await deliver(account, chargeEvent())).status).toBe(200)
  })

  it('does not end subscription dunning after a credit purchase', async () => {
    mocks.invoicePayments.mockResolvedValue({ data: [] })
    expect((await deliver(account, chargeEvent('charge.succeeded'))).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('still ends dunning after a subscription charge succeeds', async () => {
    expect((await deliver(account, chargeEvent('charge.succeeded'))).status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).events[0].type).toBe('org:charge_succeeded')
  })

  it('still ignores failed credit purchases', async () => {
    mocks.invoicePayments.mockResolvedValue({ data: [] })
    expect((await deliver(account, chargeEvent())).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
