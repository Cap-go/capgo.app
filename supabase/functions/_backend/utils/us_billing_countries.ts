// The US entity bills without automatic tax, so it is only offered in the Americas and Asia-Pacific.
// Europe, the Middle East and Africa stay on EE (EU VAT goes through the Estonian entity). French and
// Danish overseas territories follow their EU country; Cuba, North Korea and Afghanistan are
// sanctioned. Local tax thresholds (e.g. Australian GST) are tracked outside the code.
const US_BILLING_COUNTRIES = new Set([
  // North America and US territories
  'US', 'CA', 'MX', 'BM', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM',
  // Central America and the Caribbean
  'BZ', 'CR', 'SV', 'GT', 'HN', 'NI', 'PA', 'AG', 'AI', 'AW', 'BB', 'BQ', 'BS', 'CW', 'DM', 'DO', 'GD', 'HT', 'JM', 'KN', 'KY', 'LC', 'MS', 'SX', 'TC', 'TT', 'VC', 'VG',
  // South America
  'AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE',
  // East and Southeast Asia
  'JP', 'KR', 'CN', 'HK', 'MO', 'TW', 'MN', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'BN', 'KH', 'LA', 'MM', 'TL',
  // South Asia
  'IN', 'PK', 'BD', 'LK', 'NP', 'BT', 'MV',
  // Oceania
  'AU', 'NZ', 'CX', 'CC', 'NF', 'FJ', 'PG', 'SB', 'VU', 'WS', 'TO', 'KI', 'TV', 'NR', 'FM', 'MH', 'PW', 'CK', 'NU', 'TK', 'PN',
])

export function isUsBillingCountry(country: string | null | undefined): boolean {
  return !!country && US_BILLING_COUNTRIES.has(country.toUpperCase())
}
