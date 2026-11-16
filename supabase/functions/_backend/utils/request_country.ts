import type { Context } from 'hono'

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const country = value.trim().toUpperCase()
  // Cloudflare uses XX for unknown locations and T1 for Tor, neither is a country.
  return /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null
}

export function getRequestCountry(c: Context): string | null {
  // Prefer the Worker-provided location; the header covers proxied Supabase requests.
  const raw = (c.req.raw as { cf?: { country?: unknown } } | undefined)?.cf?.country ?? c.req.header('cf-ipcountry')
  return normalizeCountryCode(raw)
}
