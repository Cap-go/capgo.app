import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { Database } from './supabase.types.ts'
import { cloudlog } from './logging.ts'
import { getStripe } from './stripe.ts'
import { getStripeCustomerId } from './stripe_event.ts'
import { supabaseAdmin } from './supabase.ts'

type StripeRefundInsert = Database['public']['Tables']['stripe_refunds']['Insert']

const MAX_REFUNDS_PER_CHARGE = 1000

export function toStripeRefundRow(refund: Stripe.Refund, charge: Pick<Stripe.Charge, 'id' | 'customer'>): StripeRefundInsert {
  return {
    id: refund.id,
    charge_id: charge.id,
    customer_id: getStripeCustomerId(charge.customer) || null,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status ?? 'pending',
    reason: refund.reason ?? null,
    refunded_at: new Date(refund.created * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }
}

// charge.refunded only carries the cumulative amount_refunded, so list the
// charge refunds to keep one row per refund with its own date and status.
export async function recordChargeRefunds(c: Context, charge: Stripe.Charge): Promise<number> {
  const refunds = await getStripe(c).refunds.list({ charge: charge.id, limit: 100 }).autoPagingToArray({ limit: MAX_REFUNDS_PER_CHARGE })

  if (refunds.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'charge.refunded without refunds', chargeId: charge.id })
    return 0
  }

  const rows = refunds.map(refund => toStripeRefundRow(refund, charge))
  const { error } = await supabaseAdmin(c)
    .from('stripe_refunds')
    .upsert(rows, { onConflict: 'id' })

  if (error)
    throw error

  cloudlog({ requestId: c.get('requestId'), message: 'Recorded Stripe refunds', chargeId: charge.id, count: rows.length })
  return rows.length
}
