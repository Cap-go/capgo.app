import { effectiveBillingCurrency } from './billing_currency.ts'
import type { Context } from 'hono'
import type Stripe from 'stripe'
import { stripeAmountToMajorUnits } from '../../shared/stripe-amount.ts'
import { currencyForCountry } from './country_currency.ts'
import { simpleError } from './hono.ts'
import { queryJsonOne, servicePrincipal, withRlsContext } from './pg_rls.ts'

export interface CreditQuote {
  currency: string
  unitAmount: number
  unitPrice: number
  priceData?: { currency: string, product: string, unit_amount_decimal: Stripe.Decimal, tax_behavior?: 'inclusive' | 'exclusive' }
}

export function resolveCreditQuote(price: Stripe.Price, customer: Stripe.Customer): CreditQuote {
  const local = currencyForCountry(customer.address?.country)
  const currency = customer.currency?.toLowerCase() || (local && (local === price.currency || price.currency_options?.[local]) ? local : price.currency)
  const option = currency === price.currency ? price : price.currency_options?.[currency]
  const amount = option?.unit_amount ?? Number(option?.unit_amount_decimal ?? Number.NaN)
  if (!price.active || price.type !== 'one_time' || price.billing_scheme !== 'per_unit' || price.transform_quantity || !Number.isFinite(amount) || amount <= 0)
    throw simpleError('credit_currency_unavailable', 'Credits are not available in your billing currency. Contact support.', { currency })
  return { currency, unitAmount: amount, unitPrice: stripeAmountToMajorUnits(amount, currency) }
}

export async function getCreditQuote(stripe: Stripe, customerId: string, priceId: string, c?: Context): Promise<CreditQuote> {
  const [customer, price] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.prices.retrieve(priceId, { expand: ['currency_options'] }),
  ])
  if (customer.deleted)
    throw simpleError('no_customer', 'No customer')
  customer.currency = await effectiveBillingCurrency(stripe, customer)
  const wanted = customer.currency?.toLowerCase() || currencyForCountry(customer.address?.country)
  if (c && wanted && wanted !== price.currency && !price.currency_options?.[wanted]) {
    const product = typeof price.product === 'string' ? price.product : price.product.id
    // Use the same full-price catalog ratios as extra MAU, never a regional discount.
    const plan = await withRlsContext(c, servicePrincipal, client => queryJsonOne<{ price_m_id: string | null, price_m_id_us: string | null, credit_id: string | null }>(client,
      'SELECT price_m_id, price_m_id_us, credit_id FROM public.plans WHERE credit_id = $1 OR credit_id_us = $1 ORDER BY price_m ASC LIMIT 1', [product]))
    const referenceId = plan?.credit_id === product ? plan?.price_m_id : plan?.price_m_id_us
    if (referenceId) {
      const reference = await stripe.prices.retrieve(referenceId, { expand: ['currency_options'] })
      const usd = reference.currency === 'usd' ? reference.unit_amount : reference.currency_options?.usd?.unit_amount
      const local = reference.currency === wanted ? reference.unit_amount : reference.currency_options?.[wanted]?.unit_amount
      if (reference.active && price.currency === 'usd' && usd && local) {
        const base = resolveCreditQuote(price, { ...customer, currency: 'usd' })
        const unitAmount = Number((base.unitAmount * local / usd).toFixed(12))
        const quote = resolveCreditQuote({ ...price, currency_options: { ...price.currency_options, [wanted]: { unit_amount: null, unit_amount_decimal: String(unitAmount) } } } as Stripe.Price, { ...customer, currency: wanted })
        return { ...quote, priceData: { currency: wanted, product, unit_amount_decimal: String(unitAmount) as unknown as Stripe.Decimal, ...(price.tax_behavior === 'inclusive' || price.tax_behavior === 'exclusive' ? { tax_behavior: price.tax_behavior } : {}) } }
      }
    }
  }
  return resolveCreditQuote(price, customer)
}
