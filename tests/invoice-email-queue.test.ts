import type Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { queueInvoiceEmail } from '../supabase/functions/_backend/utils/invoice_email.ts'
import { cleanupPostgresClient, executeSQL, PRODUCT_ID, requestDirectDatabaseRoute, USER_ID } from './test-utils.ts'

const orgId = randomUUID()
const customerId = `cus_invoice_email_${orgId}`

beforeAll(async () => {
  await executeSQL('INSERT INTO public.stripe_info (customer_id, product_id) VALUES ($1, $2)', [customerId, PRODUCT_ID])
  await executeSQL(`INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
    VALUES ($1, $2, 'Invoice email queue test', '', $3)`, [orgId, USER_ID, customerId])
})

afterAll(async () => {
  await executeSQL(`DELETE FROM pgmq.q_send_email WHERE message->'payload'->>'invoice_delivery_id' IN
    (SELECT id::text FROM public.invoice_email_deliveries WHERE org_id = $1)`, [orgId])
  await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
  await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  await cleanupPostgresClient()
})

async function enqueue(invoiceId: string, customerEmail: string | null, type = 'invoice.paid') {
  const event = { type, data: { object: {
    id: invoiceId, customer: customerId, customer_email: customerEmail,
    number: 'EXAMPLE-01', status: 'paid', amount_paid: 1400,
  } } } as Stripe.Event
  await requestDirectDatabaseRoute((app) => {
    app.get('/', async (c) => {
      await queueInvoiceEmail(c, orgId, 'ee', event)
      return c.json({ ok: true })
    })
  })
}

async function decision(invoiceId: string) {
  return executeSQL<{ recipients: string[], queued: boolean }>(`
    SELECT d.recipients, EXISTS (
      SELECT 1 FROM pgmq.q_send_email q WHERE q.message->'payload'->>'invoice_delivery_id' = d.id::text
    ) AS queued FROM public.invoice_email_deliveries d WHERE d.invoice_id = $1 AND d.org_id = $2
  `, [invoiceId, orgId])
}

describe('invoice email queue in Postgres', () => {
  it.each([null, '', '   '])('records a missing mailbox without queuing or sending on replay (%j)', async (email) => {
    const invoiceId = `in_missing_email_${randomUUID()}`
    await executeSQL('DELETE FROM public.invoice_email_preferences WHERE org_id = $1', [orgId])
    await executeSQL("UPDATE public.orgs SET management_email = '' WHERE id = $1", [orgId])
    await enqueue(invoiceId, email)
    expect(await decision(invoiceId)).toEqual([{ recipients: [], queued: false }])

    await executeSQL(`INSERT INTO public.invoice_email_preferences (org_id, recipients)
      VALUES ($1, ARRAY['new-billing@example.com'])`, [orgId])
    await enqueue(invoiceId, 'new-billing@example.com', 'invoice.payment_succeeded')
    expect(await decision(invoiceId)).toEqual([{ recipients: [], queued: false }])
  })

  it('falls back to the management mailbox once for both paid event types', async () => {
    const invoiceId = `in_fallback_email_${randomUUID()}`
    await executeSQL('DELETE FROM public.invoice_email_preferences WHERE org_id = $1', [orgId])
    await executeSQL("UPDATE public.orgs SET management_email = 'billing@example.com' WHERE id = $1", [orgId])
    await enqueue(invoiceId, '   ')
    await enqueue(invoiceId, null, 'invoice.payment_succeeded')
    expect(await decision(invoiceId)).toEqual([{ recipients: ['billing@example.com'], queued: true }])
    const queued = await executeSQL(`SELECT q.msg_id FROM pgmq.q_send_email q
      JOIN public.invoice_email_deliveries d ON d.id::text = q.message->'payload'->>'invoice_delivery_id'
      WHERE d.invoice_id = $1`, [invoiceId])
    expect(queued).toHaveLength(1)
  })
})
