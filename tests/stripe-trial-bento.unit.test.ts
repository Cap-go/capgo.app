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
  mocks.getStripe.mockReturnValue({ webhooks: stripe.webhooks, customers: { retrieve: mocks.retrieve } })
  database('ee')
})
afterEach(() => vi.unstubAllGlobals())

describe.each(['ee', 'us'] as const)('%s Stripe customer creation forwarding', (account) => {
  beforeEach(() => database(account))

  it('sends the exact event to one normalized Stripe email while preserving linked billing sync', async () => {
    // The owner and other members have different addresses; only the customer's
    // billing address belongs in this compatibility event, never a member list.
    const response = await deliver(account)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/batch/events')
    expect(JSON.parse(init.body)).toEqual({ events: [{
      type: 'org:legacy_stripe_trial_started',
      email: 'billing@example.com',
      details: {
        customer_id: org.customer_id,
        stripe_event_id: 'evt_synthetic_trial',
        billing_account: account,
        created_at: '2025-10-09T08:53:20.000Z',
        org_id: org.id,
      },
    }] })
    expect(mocks.table.mock.calls.map(([table]) => table)).not.toContain('users')
    expect(mocks.table.mock.calls.map(([table]) => table)).not.toContain('org_users')
    expect(mocks.memberEmails).not.toHaveBeenCalled()
    expect(mocks.syncCountry).toHaveBeenCalledOnce()
    expect(mocks.ensureMetadata).toHaveBeenCalledOnce()
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith(org.customer_id)
    expect(mocks.getStripe.mock.calls.every(([, selected]) => selected === account)).toBe(true)
  })

  it('forwards through the production API Worker route', async () => {
    database(account, false)
    const response = await deliver(account, customerEvent(), { worker: true })
    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledOnce()
  })

  it('forwards before org/stripe_info provisioning without a live customer or account fallback', async () => {
    database(account, false)
    expect((await deliver(account)).status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.table).toHaveBeenCalledExactlyOnceWith('orgs')
    expect(mocks.retrieve).not.toHaveBeenCalled()
    expect(mocks.syncCountry).not.toHaveBeenCalled()
    expect(mocks.ensureMetadata).not.toHaveBeenCalled()
    expect(mocks.getStripe).toHaveBeenCalledExactlyOnceWith(expect.anything(), account)
  })

  it('does not require org metadata to forward a customer', async () => {
    database(account, false)
    const event = customerEvent()
    event.data.object.metadata = {} as any
    expect((await deliver(account, event)).status).toBe(200)
    const details = JSON.parse(mocks.fetch.mock.calls[0][1].body).events[0].details
    expect(details).not.toHaveProperty('org_id')
  })

  it('does not forward customer.updated', async () => {
    expect((await deliver(account, customerEvent('customer.updated'))).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.syncCountry).toHaveBeenCalledOnce()
  })

  it('does not forward another event type', async () => {
    const event = { ...customerEvent(), type: 'charge.refunded', data: { object: { object: 'charge', customer: null } } }
    expect((await deliver(account, event)).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([null, '', '   '])('explicitly skips missing email %s without guessing another recipient', async (email) => {
    const event = customerEvent()
    event.data.object.email = email as any
    expect((await deliver(account, event)).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ reason: 'missing_customer_email' }))
  })

  it.each(['BENTO_PUBLISHABLE_KEY', 'BENTO_SECRET_KEY', 'BENTO_SITE_UUID'])('explicitly skips when %s is missing', async (key) => {
    const env = environment()
    env[key] = ''
    expect((await deliver(account, customerEvent(), { env })).status).toBe(200)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ reason: 'bento_not_configured' }))
  })

  it('keeps the original creation email when the live billing email changed before delivery', async () => {
    mocks.retrieve.mockResolvedValue({ email: 'changed@example.com' })
    expect((await deliver(account)).status).toBe(200)
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).events[0].email).toBe('billing@example.com')
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith(org.customer_id)
    expect(mocks.orgUpdates).toHaveBeenCalledExactlyOnceWith({ management_email: 'changed@example.com' })
  })

  it.each(['network', 'http', 'partial', 'json'])('returns a retryable failure when Bento fails: %s', async (failure) => {
    if (failure === 'network')
      mocks.fetch.mockRejectedValueOnce(new Error('Synthetic outage'))
    else if (failure === 'http')
      mocks.fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
    else if (failure === 'partial')
      mocks.fetch.mockResolvedValueOnce(Response.json({ results: 1, failed: 1 }))
    else
      mocks.fetch.mockResolvedValueOnce(new Response('invalid JSON'))
    expect((await deliver(account)).status).toBe(503)
    expect((await deliver(account)).status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([null, 'invalid', 'other_account'])('rejects missing/invalid/wrong-account signatures: %s', async (signature) => {
    const event = customerEvent()
    const otherSecret = account === 'ee' ? environment().STRIPE_WEBHOOK_SECRET_US : environment().STRIPE_WEBHOOK_SECRET
    const header = signature === 'other_account'
      ? stripe.webhooks.generateTestHeaderString({ payload: JSON.stringify(event), secret: otherSecret })
      : signature
    const response = await deliver(account, event, { signature: header })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mocks.table).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('rejects a linked billing account mismatch before customer retrieval or forwarding', async () => {
    database(account, true, account === 'ee' ? 'us' : 'ee')
    expect((await deliver(account)).status).toBe(400)
    expect(mocks.retrieve).not.toHaveBeenCalled()
    expect(mocks.syncCountry).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
