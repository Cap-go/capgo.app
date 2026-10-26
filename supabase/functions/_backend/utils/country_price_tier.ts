// Regional price tiers (purchasing power parity). A Stripe price has one amount per currency, so countries
// sharing a currency (the euro) can only pay different amounts through different prices: each tier is
// its own set of Stripe prices, named per plan in plans.regional_price_ids, priced at that share of USD.
export const PRICE_TIERS = ['p115', 'p100', 'p85', 'p70', 'p60', 'p50'] as const
export type PriceTier = typeof PRICE_TIERS[number]

// The prices in plans.price_m_id / price_y_id (+ _us); also any country not listed below.
export const FULL_PRICE_TIER: PriceTier = 'p100'

// World Bank 2025 price level (PPP factor / exchange rate), nearest tier, floored at half price.
// Haiti and Iran are set to half price (exchange-rate distortions); territories without data follow the
// country they share prices with. Moving a country needs no Stripe change.
const TIER_COUNTRIES: Record<PriceTier, string[]> = {
  p115: ['BB', 'BM', 'CH', 'IS', 'KY', 'LI'],
  p100: ['AS', 'BQ', 'BS', 'FM', 'FO', 'GU', 'IL', 'IO', 'LU', 'MH', 'MP', 'NR', 'TC', 'UM', 'US', 'VG'],
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
