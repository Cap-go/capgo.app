import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PriceTier } from '../utils/country_price_tier.ts'
import type { BillingAccount } from '../utils/stripe_billing.ts'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { currencyForCountry, isCurrencyAllowedForCountry } from '../utils/country_currency.ts'
import { priceTierForCountry } from '../utils/country_price_tier.ts'
import { cloudlogErr, serializeError } from '../utils/logging.ts'
import { getCheckoutPlanPrice, getPriceCurrencyAmounts, getStripeCustomerCurrency } from '../utils/stripe.ts'
import { getBillingAccountForCustomer, getRequestCountry, isStripeConfiguredForAccount } from '../utils/stripe_billing.ts'
import { supabaseClient } from '../utils/supabase.ts'

const PLAN_PRICES_CACHE_PATH = '/private/plan_prices'
const PLAN_PRICES_TTL_SECONDS = 60 * 60
// A partial catalog is kept only briefly, under its own key, so an outage does not hit Stripe on every page view.
const PLAN_PRICES_DEGRADED_TTL_SECONDS = 60
const DEFAULT_CURRENCY = 'usd'

// Smallest-unit amounts per currency, keyed by plan product id (plans.stripe_id) and interval.
export type PlanPriceAmounts = Record<string, { month: Record<string, number>, year: Record<string, number> }>

// Currencies every plan and interval is sold in: a plan whose price failed to load disables them all,
// so switching never leaves a card on a fallback price.
export function getCommonCurrencies(prices: PlanPriceAmounts) {
  const sets = Object.values(prices).flatMap(plan => [plan.month, plan.year])
  if (!sets.length)
    return []
  return Object.keys(sets[0]).filter(currency => sets.every(amounts => currency in amounts)).sort((a, b) => a.localeCompare(b))
}

export function pickPriceCurrencies(prices: PlanPriceAmounts, keep: Set<string>): PlanPriceAmounts {
  const pick = (amounts: Record<string, number>) => Object.fromEntries(Object.entries(amounts).filter(([currency]) => keep.has(currency)))
  return Object.fromEntries(Object.entries(prices).map(([plan, { month, year }]) => [plan, { month: pick(month), year: pick(year) }]))
}

export function pickCurrency(currencies: string[], lockedCurrency: string | null, country: string | null) {
  if (lockedCurrency)
    return currencies.includes(lockedCurrency) ? lockedCurrency : null
  const local = currencyForCountry(country)
  if (local && currencies.includes(local))
    return local
  return currencies.includes(DEFAULT_CURRENCY) ? DEFAULT_CURRENCY : currencies[0] ?? null
}

interface PlanPriceRow {
  stripe_id: string
  price_m_id: string
  price_y_id: string
  price_m_id_us: string | null
  price_y_id_us: string | null
  regional_price_ids: unknown
}

async function listPlans(c: Context, authorization: string): Promise<PlanPriceRow[]> {
  const { data: plans, error } = await supabaseClient(c, authorization)
    .from('plans')
    .select('stripe_id, price_m_id, price_y_id, price_m_id_us, price_y_id_us, regional_price_ids')
  if (error)
    throw simpleError('plans_not_found', 'Cannot load plans', { error })
  return plans ?? []
}

// Changes whenever a plan switches to another Stripe price, so the cached catalog never outlives it.
export function planPricesVersion(plans: PlanPriceRow[]) {
  const ids = plans.flatMap(plan => [plan.stripe_id, plan.price_m_id, plan.price_y_id, plan.price_m_id_us ?? '', plan.price_y_id_us ?? '', JSON.stringify(plan.regional_price_ids ?? {})]).sort((a, b) => a.localeCompare(b)).join(',')
  let hash = 0x811C9DC5
  for (let i = 0; i < ids.length; i++) {
    hash ^= ids.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

async function loadPlanPrices(c: Context, plans: PlanPriceRow[], billingAccount: BillingAccount, tier: PriceTier): Promise<{ prices: PlanPriceAmounts, complete: boolean }> {
  let complete = true
  const entries = await Promise.all(plans.map(async ({ stripe_id }) => {
    try {
      const [month, year] = await Promise.all([
        getCheckoutPlanPrice(c, stripe_id, 'month', billingAccount, tier),
        getCheckoutPlanPrice(c, stripe_id, 'year', billingAccount, tier),
      ])
      // A null price means the lookup and its stored-ID fallback both failed: do not cache it.
      if (!month || !year)
        complete = false
      return [stripe_id, {
        month: month ? getPriceCurrencyAmounts(month) : {},
        year: year ? getPriceCurrencyAmounts(year) : {},
      }] as const
    }
    catch (priceError) {
      // One broken plan must not hide the others; its empty amounts disable localized currencies.
      complete = false
      cloudlogErr({ requestId: c.get('requestId'), message: 'plan_prices price lookup failed', planProductId: stripe_id, error: serializeError(priceError) })
      return [stripe_id, { month: {}, year: {} }] as const
    }
  }))
  return { prices: Object.fromEntries(entries), complete }
}

async function getPlanPrices(c: Context, authorization: string, billingAccount: BillingAccount, tier: PriceTier) {
  const plans = await listPlans(c, authorization)
  const cache = new CacheHelper(c)
  const version = planPricesVersion(plans)
  const key = cache.buildRequest(PLAN_PRICES_CACHE_PATH, { account: billingAccount, tier, version })
  const degradedKey = cache.buildRequest(PLAN_PRICES_CACHE_PATH, { account: billingAccount, tier, version, degraded: '1' })
  const cached = await cache.matchJson<PlanPriceAmounts>(key, { timeoutMs: 200 })
  if (cached)
    return { prices: cached, complete: true }
  const degraded = await cache.matchJson<PlanPriceAmounts>(degradedKey, { timeoutMs: 200 })
  if (degraded)
    return { prices: degraded, complete: false }
  const { prices, complete } = await loadPlanPrices(c, plans, billingAccount, tier)
  // Never write a partial catalog to the main key: it expires within a minute and the failed plans are retried.
  await cache.putJson(complete ? key : degradedKey, prices, complete ? PLAN_PRICES_TTL_SECONDS : PLAN_PRICES_DEGRADED_TTL_SECONDS, { timeoutMs: 200 })
  return { prices, complete }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

// Plan prices in every currency configured on the Stripe prices, plus which one this org should see.
app.get('/', middlewareAuth, async (c) => {
  const orgId = c.req.query('orgId')
  if (!orgId)
    throw simpleError('no_org_id_provided', 'No org_id provided')
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')

  // RLS: only members of the org can read its billing currency.
  const { data: org, error } = await supabaseClient(c, authorization)
    .from('orgs')
    .select('customer_id')
    .eq('id', orgId)
    .single()
  if (error || !org)
    throw simpleError('not_authorized', 'Not authorized')

  const billingAccount = org.customer_id ? await getBillingAccountForCustomer(c, org.customer_id) : 'ee'
  if (!isStripeConfiguredForAccount(c, billingAccount))
    return c.json({ complete: true, currencies: [], currency: null, lockedCurrency: null, prices: {} })

  const country = getRequestCountry(c)
  // Regional (PPP) prices: the visitor's country picks the tier, exactly as checkout does.
  const tier = priceTierForCountry(country)
  // Fail closed: an unknown customer currency must not unlock currencies checkout would reject.
  const [{ prices, complete }, lockedCurrency] = await Promise.all([
    getPlanPrices(c, authorization, billingAccount, tier),
    org.customer_id ? getStripeCustomerCurrency(c, org.customer_id, billingAccount) : null,
  ])
  // A pinned customer can only check out in its own currency; empty when the catalog lacks it.
  const common = getCommonCurrencies(prices)
  // PPP prices: a new customer only sees USD and their own country's currency, which checkout enforces too.
  const currencies = lockedCurrency
    ? common.filter(currency => currency === lockedCurrency)
    : common.filter(currency => isCurrencyAllowedForCountry(currency, country))
  return c.json({
    // False when some Stripe prices failed to load: the page offers a retry and keeps checkout disabled.
    complete,
    currencies,
    // Null means no currency is sold on every plan: the page shows the stored USD prices.
    currency: pickCurrency(currencies, lockedCurrency, country),
    lockedCurrency,
    // USD stays in: the page derives each currency's ratio from it (Enterprise extra MAU).
    prices: pickPriceCurrencies(prices, new Set([...currencies, DEFAULT_CURRENCY])),
  })
})
