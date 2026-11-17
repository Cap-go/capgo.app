import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { InvoiceEmailPreferences } from '../../shared/invoice-email.ts'
import type { BillingAccount } from './stripe.ts'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { invoiceEmailPreferencesSchema } from '../../shared/invoice-email.ts'
import { simpleError } from './hono.ts'
import { closeClient, getPgClient, withPgTransaction } from './pg.ts'

export async function getInvoiceEmailPreferences(c: Context, orgId: string, ctx: InAppBillingContext): Promise<InvoiceEmailPreferences> {
  const pool = await getPgClient(c)
  try {
    const result = await pool.query<{ enabled: boolean, recipients: string[], management_email: string }>(`
      SELECT COALESCE(p.enabled, true) AS enabled, COALESCE(p.recipients, '{}') AS recipients, o.management_email
      FROM public.orgs o LEFT JOIN public.invoice_email_preferences p ON p.org_id = o.id WHERE o.id = $1
    `, [orgId])
    const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
    const row = result.rows[0]
    return { enabled: row?.enabled ?? true, recipients: row?.recipients ?? [], defaultEmail: (!customer.deleted && customer.email) || row?.management_email || '' }
  }
  finally {
    closeClient(c, pool)
  }
}

export async function updateInvoiceEmailPreferences(c: Context, orgId: string, input: unknown) {
  const parsed = invoiceEmailPreferencesSchema.safeParse(input)
  if (!parsed.success)
    throw simpleError('invalid_invoice_email_preferences', 'Choose up to five valid invoice email addresses')
  const pool = await getPgClient(c)
  try {
    await pool.query(`
      INSERT INTO public.invoice_email_preferences (org_id, enabled, recipients) VALUES ($1, $2, $3)
      ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, recipients = EXCLUDED.recipients
    `, [orgId, parsed.data.enabled, parsed.data.recipients])
    return parsed.data
  }
  finally {
    closeClient(c, pool)
  }
}

export function paidInvoiceForEmail(event: Stripe.Event): Stripe.Invoice | null {
  if (event.type !== 'invoice.paid' && event.type !== 'invoice.payment_succeeded')
    return null
  const invoice = event.data.object
  return invoice.status === 'paid' && invoice.amount_paid > 0 && invoice.number ? invoice : null
}

export async function queueInvoiceEmail(c: Context, orgId: string, billingAccount: BillingAccount, event: Stripe.Event) {
  const invoice = paidInvoiceForEmail(event)
  if (!invoice)
    return
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  const pool = await getPgClient(c)
  try {
    await withPgTransaction(pool, async (client) => {
      // Check ownership and snapshot recipients in the same write, including empty decisions.
      // Replay cannot pick up new recipients after an opt-out or missing mailbox.
      const result = await client.query<{ id: string, recipients: string[] }>(`
        INSERT INTO public.invoice_email_deliveries (org_id, billing_account, customer_id, invoice_id, recipients)
        SELECT o.id, $2, $3, $4, CASE WHEN NOT COALESCE(p.enabled, true) THEN '{}'::text[]
          WHEN cardinality(p.recipients) > 0 THEN p.recipients
          ELSE array_remove(ARRAY[COALESCE(NULLIF(trim($5), ''), NULLIF(trim(o.management_email), ''))], NULL) END
        FROM public.orgs o LEFT JOIN public.invoice_email_preferences p ON p.org_id = o.id
        WHERE o.id = $1 AND o.customer_id = $3
        ON CONFLICT (billing_account, invoice_id) DO NOTHING RETURNING id, recipients
      `, [orgId, billingAccount, customerId, invoice.id, invoice.customer_email])
      const delivery = result.rows[0]
      if (!delivery?.recipients.length)
        return
      await client.query(`SELECT pgmq.send('send_email', $1::jsonb)`, [JSON.stringify({
        function_name: 'send_email', function_type: 'cloudflare', payload: { invoice_delivery_id: delivery.id },
      })])
    })
  }
  finally {
    closeClient(c, pool)
  }
}
