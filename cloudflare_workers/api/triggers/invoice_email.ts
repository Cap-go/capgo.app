import type { Context } from 'hono'
import type { BillingAccount } from '../../../supabase/functions/_backend/utils/stripe.ts'
import { getInvoiceDocument } from '../../../supabase/functions/_backend/utils/invoice_document.ts'
import { closeClient, getPgClient, withPgTransaction } from '../../../supabase/functions/_backend/utils/pg.ts'
import { getStripe } from '../../../supabase/functions/_backend/utils/stripe.ts'
import { getEnv } from '../../../supabase/functions/_backend/utils/utils.ts'
import { renderInvoiceAttachment } from '../email_templates/invoice_pdf.ts'
import { escapeHtml } from '../email_templates/render.ts'
import { sendCloudflareEmail } from '../email_templates/send.ts'

interface Delivery {
  id: string
  org_id: string
  customer_id: string
  billing_account: BillingAccount
  invoice_id: string
  recipients: string[]
  accepted_recipients: string[]
  completed_at: string | null
  enabled: boolean
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Invoice email operation timed out')), timeoutMs)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

async function prepareEmail(c: Context, delivery: Delivery) {
  const document = await getInvoiceDocument({ stripe: getStripe(c, delivery.billing_account), customerId: delivery.customer_id, billingAccount: delivery.billing_account, publishableKey: '' }, delivery.invoice_id)
  if (document.status !== 'paid')
    throw new Error('Invoice is not paid')
  const billingUrl = new URL('/settings/organization/billing', getEnv(c, 'WEBAPP_URL'))
  billingUrl.searchParams.set('oid', delivery.org_id)
  const content = await renderInvoiceAttachment(document, billingUrl.toString(), billingUrl.origin)
  return { document, billingUrl, content }
}

export async function sendInvoiceEmail(c: Context, deliveryId: string) {
  const pool = await getPgClient(c)
  let failed = false
  try {
    await withPgTransaction(pool, async (client) => {
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 60000')
      const { rows } = await client.query<Delivery>(`
        SELECT d.*, COALESCE(p.enabled, true) AS enabled FROM public.invoice_email_deliveries d
        LEFT JOIN public.invoice_email_preferences p ON p.org_id = d.org_id
        WHERE d.id = $1 FOR UPDATE OF d
      `, [deliveryId])
      const delivery = rows[0]
      if (!delivery || delivery.completed_at)
        return
      if (!delivery.enabled || !delivery.recipients.length) {
        await client.query('UPDATE public.invoice_email_deliveries SET completed_at = now() WHERE id = $1', [deliveryId])
        return
      }
      const pending = delivery.recipients.filter(email => !delivery.accepted_recipients.includes(email))
      if (!pending.length)
        return
      // Preparation has no email side effects. A timed-out read/render cannot send later.
      const { document, billingUrl, content } = await bounded(prepareEmail(c, delivery), 20000)
      const subject = `Your Capgo invoice ${document.number.replace(/[\r\n]/g, ' ')}`
      const results = await Promise.allSettled(pending.map(email => bounded(sendCloudflareEmail(c, email, {
        subject,
        text: `${document.summary}. Your invoice is attached.\n\nManage billing and invoice emails: ${billingUrl}`,
        html: `<p>${escapeHtml(document.summary)}. Your invoice is attached.</p><p><a href="${escapeHtml(billingUrl.toString())}">Manage billing and invoice emails</a></p>`,
        attachments: [{ filename: `invoice-${document.number.replace(/[^\w-]/g, '_')}.pdf`, content, type: 'application/pdf', disposition: 'attachment' }],
      }, { invoiceDeliveryId: deliveryId }), 8000)))
      const accepted = [...delivery.accepted_recipients, ...pending.filter((_, i) => results[i].status === 'fulfilled')]
      failed = results.some(result => result.status === 'rejected')
      // Commit partial successes before requesting a retry: already accepted recipients are skipped.
      await client.query(`UPDATE public.invoice_email_deliveries SET accepted_recipients = $2,
        completed_at = CASE WHEN $3 THEN NULL ELSE now() END WHERE id = $1`, [deliveryId, accepted, failed])
    }, { appendSql: 'SET LOCAL statement_timeout = 2000; SET LOCAL lock_timeout = 2000' })
  }
  finally {
    closeClient(c, pool)
  }
  if (failed)
    throw new Error('Invoice email delivery failed for one or more recipients')
}
