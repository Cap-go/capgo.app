import type { Context } from 'hono'
import { getEnv } from './utils.ts'

export const DEFAULT_PUBLIC_API_URL = 'https://api.capgo.app'

// API hostnames that serve the same worker as api.capgo.app but stay
// reachable from mainland China (api.capgo.app is DNS poisoned there).
const CHINA_API_HOSTNAMES = new Set(['api.capgo.com.cn'])

export function isChinaApiHostname(hostname: string): boolean {
  return CHINA_API_HOSTNAMES.has(hostname.replace(/\.$/, '').toLowerCase())
}

/** Origin of the China API host when this request came in on it, else null. */
export function chinaApiOriginForRequest(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    if (isChinaApiHostname(url.hostname))
      return `https://${url.hostname.replace(/\.$/, '').toLowerCase()}`
  }
  catch {
    return null
  }
  return null
}

/**
 * Base URL for API links we hand back to a client (upload URLs, Location
 * headers). A request made on the China API host gets the China host back so
 * the follow-up call does not go to api.capgo.app, which China blocks.
 */
export function getPublicApiUrl(c: Context, fallback = DEFAULT_PUBLIC_API_URL): string {
  return chinaApiOriginForRequest(c.req.url) ?? (getEnv(c, 'PUBLIC_URL') || fallback)
}
