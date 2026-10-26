import type { Ref } from 'vue'
import { computed, ref, watch } from 'vue'
import { invokeCapgoApi } from '~/services/capgoApi'
import { formatNumber } from '~/services/formatLocale'
import { stripeAmountToMajorUnits } from '../../supabase/functions/shared/stripe-amount.ts'

const STORAGE_KEY = 'capgo_plan_currency'

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
  // Regional discount (purchasing power) on the plans listed in regularPrices; needs a local card and address.
  discount?: { percent: number, country: string | null } | null
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
    // A partial catalog is treated like a failed lookup: retry, checkout stays disabled.
    ready.value = !!data.value && data.value.complete !== false
    failed.value = !ready.value
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
    return data.value?.currency ?? null
  })

  function setCurrency(code: string) {
    storedCurrency.value = code
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, code)
    }
    catch {}
  }

  // Null until Stripe prices load: callers fall back to the USD amounts stored on the plan.
  function amountsFor(productId: string) {
    return data.value && currency.value ? getPlanAmounts(data.value.prices, productId, currency.value) : null
  }

  // Converts a USD figure (Enterprise extra MAU) with the plan's own per-currency ratio, as Checkout does.
  function usdRatioFor(productId: string, interval: 'month' | 'year') {
    return data.value && currency.value ? getUsdRatio(data.value.prices, productId, currency.value, interval) : null
  }

  const discount = computed(() => data.value?.discount ?? null)

  // Full price of a regionally discounted plan in the shown currency; null when the plan is not discounted.
  function regularAmountsFor(productId: string) {
    return data.value?.regularPrices && currency.value ? getPlanAmounts(data.value.regularPrices, productId, currency.value) : null
  }

  return { amountsFor, currencies, currency, discount, failed, lockedCurrency, lockedCurrencyUnavailable, ready, regularAmountsFor, reload, setCurrency, usdRatioFor }
}
