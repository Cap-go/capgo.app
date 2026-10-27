import type { Ref } from 'vue'
import { computed, ref, watch } from 'vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatNumber } from '~/services/formatLocale'
import { stripeAmountToMajorUnits } from '../../supabase/functions/shared/stripe-amount.ts'

const STORAGE_KEY = 'capgo_plan_currency'
// Set when the buyer turned down the regional discount (card or billing address from another country).
const STANDARD_PRICE_STORAGE_KEY = 'capgo_plan_standard_price'
// The server always returns the USD amounts, so they are shown when no currency is sold on every plan.
const FALLBACK_CURRENCY = 'usd'

// Smallest-unit amounts per currency, straight from the Stripe prices (currency_options).
type PlanPriceAmounts = Record<string, { month: Record<string, number>, year: Record<string, number> }>

interface PlanPricesResponse {
  // False when some Stripe prices failed to load on the server.
  complete: boolean
  // Currencies sold on every plan and interval (only the locked one for a billed customer).
  currencies: string[]
  currency: string | null
  lockedCurrency: string | null
  prices: PlanPriceAmounts
  // Regional discount (purchasing power) on the plans listed in regularPrices; needs a local card and address,
  // and is only sold in these currencies (the region's own, or USD where Stripe does not sell it).
  discount?: { percent: number, country: string | null, currencies?: string[] } | null
  // Full prices of the discounted plans, for the strike-through.
  regularPrices?: PlanPriceAmounts
}

export interface PlanAmounts {
  month: number
  year: number
}

function readStoredCurrency() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null
  }
  catch {
    return null
  }
}

function readStoredStandardPrice() {
  try {
    return globalThis.sessionStorage?.getItem(STANDARD_PRICE_STORAGE_KEY) === '1'
  }
  catch {
    return false
  }
}

// Major-unit monthly/yearly amounts for one currency, or null when Stripe does not sell the plan in it.
export function getPlanAmounts(prices: PlanPriceAmounts, productId: string, currency: string): PlanAmounts | null {
  const plan = prices[productId]
  const month = plan?.month[currency]
  const year = plan?.year[currency]
  if (month === undefined || year === undefined)
    return null
  return { month: stripeAmountToMajorUnits(month, currency), year: stripeAmountToMajorUnits(year, currency) }
}

// Local major units per USD for one plan interval (Stripe amounts of the same price), or null without both.
export function getUsdRatio(prices: PlanPriceAmounts, productId: string, currency: string, interval: 'month' | 'year'): number | null {
  const amounts = prices[productId]?.[interval]
  const local = amounts?.[currency]
  const usd = amounts?.usd
  if (local === undefined || !usd)
    return null
  return stripeAmountToMajorUnits(local, currency) / stripeAmountToMajorUnits(usd, 'usd')
}

export function formatPlanAmount(value: number, code: string, options: Intl.NumberFormatOptions = {}) {
  return formatNumber(value, { style: 'currency', currency: code.toUpperCase(), currencyDisplay: 'narrowSymbol', ...options })
}

export function usePlanPrices(orgId: Ref<string | undefined>) {
  const data = ref<PlanPricesResponse | null>(null)
  // True only once the billing currency is known: a failed lookup keeps checkout disabled,
  // since the server would force the customer's pinned currency over the card shown.
  const ready = ref(false)
  // The lookup settled without prices: the page offers a retry instead of a silent dead end.
  const failed = ref(false)
  const storedCurrency = ref(readStoredCurrency())
  // The buyer chose the full price over the regional discount: show and sell it instead.
  const standardPrice = ref(readStoredStandardPrice())

  async function load(id: string | undefined) {
    data.value = null
    ready.value = false
    failed.value = false
    if (!id)
      return
    const { data: response, error } = await invokeCapgoApi<PlanPricesResponse>(`private/plan_prices?orgId=${encodeURIComponent(id)}`, { method: 'GET' })
    if (orgId.value !== id)
      return
    data.value = !error && response ? response : null
    ready.value = !!data.value
    // A partial catalog offers a retry; only the plans whose prices failed keep checkout disabled.
    failed.value = !data.value || data.value.complete === false
  }

  watch(orgId, load, { immediate: true })

  function reload() {
    return load(orgId.value)
  }

  const currencies = computed(() => data.value?.currencies ?? [])
  const lockedCurrency = computed(() => data.value?.lockedCurrency ?? null)
  // The org is billed in a currency these plans are not sold in: checkout would be rejected.
  const lockedCurrencyUnavailable = computed(() => !!lockedCurrency.value && !currencies.value.includes(lockedCurrency.value))
  const currency = computed(() => {
    if (lockedCurrency.value)
      return lockedCurrencyUnavailable.value ? null : lockedCurrency.value
    if (storedCurrency.value && currencies.value.includes(storedCurrency.value))
      return storedCurrency.value
    return data.value ? data.value.currency ?? FALLBACK_CURRENCY : null
  })

  function setCurrency(code: string) {
    storedCurrency.value = code
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, code)
    }
    catch {}
  }

  // False when this plan's Stripe prices failed to load or lack the shown currency: checkout for it stays
  // disabled, so the page never sells a price it did not display. No prices at all means Stripe is not set up.
  function hasPricesFor(productId: string) {
    if (!data.value)
      return false
    return Object.keys(data.value.prices).length === 0 || amountsFor(productId) !== null
  }

  // A regional discount on offer in the shown currency, even while the buyer has chosen the full price.
  const regionalDiscount = computed(() => {
    const offered = data.value?.regularPrices ? data.value.discount ?? null : null
    if (!offered || !currency.value || !(offered.currencies ?? []).includes(currency.value))
      return null
    return offered
  })
  // Full prices once the buyer opts out; another market's currency never had a discount to show.
  const useStandardPrice = computed(() => !!data.value?.discount && (standardPrice.value || !regionalDiscount.value))

  function setStandardPrice(value: boolean) {
    standardPrice.value = value
    try {
      if (value)
        globalThis.sessionStorage?.setItem(STANDARD_PRICE_STORAGE_KEY, '1')
      else
        globalThis.sessionStorage?.removeItem(STANDARD_PRICE_STORAGE_KEY)
    }
    catch {}
  }

  // Prices the page shows and checkout sells: the full prices replace the discounted ones once the buyer opts out.
  const shownPrices = computed(() => {
    if (!data.value)
      return null
    return useStandardPrice.value ? { ...data.value.prices, ...data.value.regularPrices } : data.value.prices
  })

  // Null until Stripe prices load: callers fall back to the USD amounts stored on the plan.
  function amountsFor(productId: string) {
    return shownPrices.value && currency.value ? getPlanAmounts(shownPrices.value, productId, currency.value) : null
  }

  // Converts a USD figure (Enterprise extra MAU) with the plan's own per-currency ratio, as Checkout does.
  function usdRatioFor(productId: string, interval: 'month' | 'year') {
    return data.value && currency.value ? getUsdRatio(data.value.prices, productId, currency.value, interval) : null
  }

  const discount = computed(() => useStandardPrice.value ? null : regionalDiscount.value)

  // Full price of a regionally discounted plan in the shown currency; null when the plan is not discounted.
  function regularAmountsFor(productId: string) {
    if (useStandardPrice.value)
      return null
    return data.value?.regularPrices && currency.value ? getPlanAmounts(data.value.regularPrices, productId, currency.value) : null
  }

  // The plan has a regional discount on offer, whether or not the buyer chose the full price instead.
  function hasRegionalPrice(productId: string) {
    return !!regionalDiscount.value && !!data.value?.regularPrices?.[productId]
  }

  return { amountsFor, currencies, currency, discount, failed, hasPricesFor, hasRegionalPrice, lockedCurrency, lockedCurrencyUnavailable, ready, regionalDiscount, regularAmountsFor, reload, setCurrency, setStandardPrice, standardPrice: useStandardPrice, usdRatioFor }
}
