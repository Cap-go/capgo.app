import { BILLING_CURRENCY_KEY, effectiveBillingCurrency } from './billing_currency.ts'
import type { Context } from 'hono'
import type { InAppBillingContext } from './stripe_in_app.ts'
import { simpleError } from './hono.ts'
import { servicePrincipal, withRlsContext } from './pg_rls.ts'

// Call only after billing authorization or verified Stripe webhook account validation.
// Serialize fetch + write so delayed webhooks cannot overwrite a newer profile.
export async function syncBillingProfile(c: Context, ctx: Pick<InAppBillingContext, 'customerId' | 'stripe' | 'billingAccount'>) {
  return withRlsContext(c, servicePrincipal, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing-profile:${ctx.billingAccount}:${ctx.customerId}`])
    const customer = await ctx.stripe.customers.retrieve(ctx.customerId)
    if (customer.deleted)
      throw simpleError('no_customer', 'No customer')
    const result = await client.query(`UPDATE public.stripe_info
      SET customer_country = $2, billing_address = $3::jsonb, billing_currency = $4
      WHERE customer_id = $1 AND billing_account = $5 RETURNING customer_id`,
    [ctx.customerId, customer.address?.country ?? null, JSON.stringify(customer.address ?? null), (/^[a-z]{3}$/.test(customer.metadata?.[BILLING_CURRENCY_KEY] ?? '') ? customer.metadata[BILLING_CURRENCY_KEY] : await effectiveBillingCurrency(ctx.stripe, customer)), ctx.billingAccount])
    if (result.rowCount !== 1)
      throw simpleError('billing_profile_sync_failed', 'Could not synchronize billing details. Please retry.')
  })
}
