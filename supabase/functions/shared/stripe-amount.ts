// Stripe amounts are integers in the currency's smallest unit. Most currencies
// use 100 minor units, but Stripe treats some as zero-decimal or three-decimal.
// https://docs.stripe.com/currencies#special-cases
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
])

const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd'])

export function stripeMinorUnitDivisor(currency: string): number {
  const code = currency.toLowerCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code))
    return 1
  if (THREE_DECIMAL_CURRENCIES.has(code))
    return 1000
  return 100
}

export function stripeAmountToMajorUnits(amount: number, currency: string): number {
  return amount / stripeMinorUnitDivisor(currency)
}
