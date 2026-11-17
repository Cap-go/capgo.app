import type { Context } from 'hono'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoiceEmailPreferencesSchema } from '../supabase/functions/shared/invoice-email'

const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), document: vi.fn(), pdf: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({ query: mocks.query }), closeClient: vi.fn(),
  withPgTransaction: async (_pool: unknown, run: (client: unknown) => Promise<void>) => run({ query: mocks.query }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: () => 'https://console.example.com' }))
vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({ getStripe: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/invoice_document.ts', () => ({ getInvoiceDocument: mocks.document }))
vi.mock('../cloudflare_workers/api/email_templates/send.ts', () => ({ sendCloudflareEmail: mocks.send }))
vi.mock('../cloudflare_workers/api/email_templates/invoice_pdf.ts', () => ({ renderInvoiceAttachment: mocks.pdf }))
const { paidInvoiceForEmail, queueInvoiceEmail, updateInvoiceEmailPreferences } = await import('../supabase/functions/_backend/utils/invoice_email')
const { sendInvoiceEmail } = await import('../cloudflare_workers/api/triggers/invoice_email')
const c = { env: { WEBAPP_URL: 'https://console.example.com' }, get: () => 'test' } as unknown as Context
function event(type = 'invoice.paid', changes = {}) {
  return { type, data: { object: { id: 'in_example', customer: 'cus_example', number: 'EXAMPLE-01', status: 'paid', amount_paid: 1400, customer_email: 'billing@example.com', ...changes } } } as Stripe.Event
}
const delivery = { id: 'example', org_id: 'org_example', customer_id: 'cus_example', billing_account: 'ee', invoice_id: 'in_example', recipients: ['one@example.com', 'two@example.com'], accepted_recipients: [] as string[], completed_at: null as string | null, enabled: true }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.send.mockResolvedValue('accepted')
  mocks.document.mockResolvedValue({ status: 'paid', number: 'EXAMPLE-01', summary: '€14.00 paid' })
  mocks.pdf.mockResolvedValue('JVBERi0=')
})

afterEach(() => vi.useRealTimers())

describe('invoice email preferences', () => {
  it('accepts up to five mailboxes without verification and normalizes duplicates', () => {
    expect(invoiceEmailPreferencesSchema.parse({ enabled: true, recipients: [' BILLING@example.com ', 'billing@example.com'] }).recipients).toEqual(['billing@example.com'])
    expect(invoiceEmailPreferencesSchema.safeParse({ enabled: true, recipients: Array.from({ length: 5 }, (_, i) => `account${i}@example.com`) }).success).toBe(true)
  })
  it.each([['bad'], ['bad@example.com\nBcc: other@example.com'], Array.from({ length: 6 }, (_, i) => `account${i}@example.com`)])('rejects invalid or excessive recipients %j', async (...recipients) => {
    await expect(updateInvoiceEmailPreferences(c, 'org_example', { enabled: true, recipients })).rejects.toThrow()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it('allows opt out and empty default recipients', () => {
    expect(invoiceEmailPreferencesSchema.parse({ enabled: false, recipients: [] })).toEqual({ enabled: false, recipients: [] })
  })
})
describe('paid invoice dispatch', () => {
  it.each(['invoice.paid', 'invoice.payment_succeeded'])('accepts %s for subscriptions and one-off credits', (type) => {
    expect(paidInvoiceForEmail(event(type))).not.toBeNull()
  })
  it.each([event('invoice.created'), event('invoice.paid', { status: 'open' }), event('invoice.paid', { amount_paid: 0 }), event('invoice.paid', { number: null })])('ignores unpaid and trial invoices', async (e) => {
    await queueInvoiceEmail(c, 'org_example', 'ee', e)
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it('does not enqueue repeated or opted-out invoices', async () => {
    await queueInvoiceEmail(c, 'org_example', 'ee', event())
    expect(mocks.query).toHaveBeenCalledTimes(1)
    mocks.query.mockResolvedValue({ rows: [{ id: 'delivery', recipients: [] }] })
    await queueInvoiceEmail(c, 'org_example', 'ee', event())
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })
  it('enqueues a durable delivery on the existing email queue', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'delivery', recipients: ['billing@example.com'] }] })
    await queueInvoiceEmail(c, 'org_example', 'us', event())
    expect(mocks.query.mock.calls[1][1]).toEqual([JSON.stringify({ function_name: 'send_email', function_type: 'cloudflare', payload: { invoice_delivery_id: 'delivery' } })])
  })
})
describe('invoice delivery retries', () => {
  function returnDelivery(row = delivery) {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FOR UPDATE OF d') ? [row] : [] }))
  }
  it('attaches the PDF and sends separately to each mailbox', async () => {
    returnDelivery()
    await sendInvoiceEmail(c, delivery.id)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.send).toHaveBeenCalledWith(c, 'one@example.com', expect.objectContaining({ attachments: [{ filename: 'invoice-EXAMPLE-01.pdf', content: 'JVBERi0=', type: 'application/pdf', disposition: 'attachment' }] }), expect.anything())
  })
  it('persists partial acceptance before failing so retries skip successful recipients', async () => {
    returnDelivery()
    mocks.send.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce('accepted')
    await expect(sendInvoiceEmail(c, delivery.id)).rejects.toThrow('one or more recipients')
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([delivery.id, ['two@example.com'], true])
    returnDelivery({ ...delivery, accepted_recipients: ['two@example.com'] } as typeof delivery)
    mocks.send.mockClear()
    await sendInvoiceEmail(c, delivery.id)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][1]).toBe('one@example.com')
  })
  it('does not send a late PDF after preparation times out', async () => {
    vi.useFakeTimers()
    returnDelivery()
    let finish!: (value: string) => void
    mocks.pdf.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const operation = sendInvoiceEmail(c, delivery.id)
    const assertion = expect(operation).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(20001)
    await assertion
    finish('JVBERi0=')
    await Promise.resolve()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('skips completed deliveries and honors an opt-out while queued', async () => {
    returnDelivery({ ...delivery, completed_at: '2026-01-01' } as typeof delivery)
    await sendInvoiceEmail(c, delivery.id)
    returnDelivery({ ...delivery, enabled: false })
    await sendInvoiceEmail(c, delivery.id)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.document).not.toHaveBeenCalled()
  })
})
