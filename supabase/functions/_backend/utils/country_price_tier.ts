// Regional discounts (purchasing power parity). A Stripe price has one amount per currency, so countries
// sharing a currency (the euro) can only pay different amounts through different prices: each tier is
// its own set of Stripe prices, named per plan in plans.regional_price_ids, priced at that share of USD.
// Only plans with regional_price_ids use tiers (Solo); every other plan sells its full price everywhere.
// Most expensive first: never above the full price.
export const PRICE_TIERS = ['p100', 'p85', 'p70', 'p60', 'p50'] as const
export type PriceTier = typeof PRICE_TIERS[number]

// The prices in plans.price_m_id / price_y_id (+ _us); also any country not listed below.
export const FULL_PRICE_TIER: PriceTier = 'p100'

// World Bank 2025 price level (PPP factor / exchange rate), nearest tier, capped at the full price and
// floored at half price.
// Haiti and Iran are set to half price (exchange-rate distortions); territories without data follow the
// country they share prices with. Moving a country needs no Stripe change.
const TIER_COUNTRIES: Record<Exclude<PriceTier, 'p100'>, string[]> = {
  p85: ['AT', 'AU', 'AX', 'BE', 'BV', 'CA', 'CC', 'CK', 'CX', 'DE', 'DK', 'FI', 'FK', 'GB', 'GG', 'GI', 'GS', 'HM', 'IE', 'IM', 'JE', 'NF', 'NL', 'NO', 'NU', 'NZ', 'PN', 'PR', 'PW', 'SE', 'SH', 'SJ', 'SM', 'TK', 'TV', 'VI', 'VU'],
  p70: ['AD', 'AG', 'AI', 'AW', 'BL', 'CW', 'EE', 'FR', 'GF', 'GL', 'GP', 'HK', 'IT', 'KN', 'MC', 'MF', 'MQ', 'MS', 'MT', 'NC', 'PF', 'PM', 'RE', 'SB', 'SX', 'TF', 'TO', 'UY', 'VA', 'WF', 'YT'],
  p60: ['AE', 'CR', 'CY', 'CZ', 'ES', 'GD', 'GR', 'JM', 'JP', 'KI', 'KR', 'KW', 'LT', 'LV', 'MO', 'PG', 'PT', 'QA', 'SG', 'SI', 'SK', 'ST', 'VC', 'WS', 'ZW'],
  p50: ['AF', 'AL', 'AM', 'AO', 'AR', 'AZ', 'BA', 'BD', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BN', 'BO', 'BR', 'BT', 'BW', 'BY', 'BZ', 'CD', 'CF', 'CG', 'CI', 'CL', 'CM', 'CN', 'CO', 'CU', 'CV', 'DJ', 'DM', 'DO', 'DZ', 'EC', 'EG', 'EH', 'ER', 'ET', 'FJ', 'GA', 'GE', 'GH', 'GM', 'GN', 'GQ', 'GT', 'GW', 'GY', 'HN', 'HR', 'HT', 'HU', 'ID', 'IN', 'IQ', 'IR', 'JO', 'KE', 'KG', 'KH', 'KM', 'KP', 'KZ', 'LA', 'LB', 'LC', 'LK', 'LR', 'LS', 'LY', 'MA', 'MD', 'ME', 'MG', 'MK', 'ML', 'MM', 'MN', 'MR', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NE', 'NG', 'NI', 'NP', 'OM', 'PA', 'PE', 'PH', 'PK', 'PL', 'PS', 'PY', 'RO', 'RS', 'RU', 'RW', 'SA', 'SC', 'SD', 'SL', 'SN', 'SO', 'SR', 'SS', 'SV', 'SY', 'SZ', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TR', 'TT', 'TW', 'TZ', 'UA', 'UG', 'UZ', 'VE', 'VN', 'XK', 'YE', 'ZA', 'ZM'],
}

const COUNTRY_TIER = new Map(
  Object.entries(TIER_COUNTRIES).flatMap(([tier, countries]) => countries.map(country => [country, tier as PriceTier] as const)),
)

export function priceTierForCountry(country: string | null | undefined): PriceTier {
  if (!country)
    return FULL_PRICE_TIER
  return COUNTRY_TIER.get(country.toUpperCase()) ?? FULL_PRICE_TIER
}

// The discount actually granted: the most expensive tier among every country known for the buyer (visitor
// IP, billing address, card), so a VPN or a foreign address alone does not unlock a cheaper price.
export function priceTierForCountries(countries: Array<string | null | undefined>): PriceTier {
  const known = countries.filter((country): country is string => !!country)
  if (!known.length)
    return FULL_PRICE_TIER
  return known.map(priceTierForCountry).reduce<PriceTier>((max, tier) => PRICE_TIERS.indexOf(tier) < PRICE_TIERS.indexOf(max) ? tier : max, PRICE_TIERS.at(-1)!)
}

// Share of the full price a tier charges, in percent (p70 -> 70).
export function tierPricePercent(tier: PriceTier): number {
  return Number(tier.slice(1))
}

// True when `tier` is cheaper than `than`.
export function isCheaperTier(tier: PriceTier, than: PriceTier): boolean {
  return PRICE_TIERS.indexOf(tier) > PRICE_TIERS.indexOf(than)
}

export function isPriceTier(value: unknown): value is PriceTier {
  return typeof value === 'string' && (PRICE_TIERS as readonly string[]).includes(value)
}
