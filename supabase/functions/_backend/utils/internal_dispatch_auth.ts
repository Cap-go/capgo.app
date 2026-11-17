import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'

type ApikeyRow = Database['public']['Tables']['apikeys']['Row']

interface VerifiedApikey {
  key: string
  apikey: ApikeyRow
}

/**
 * API keys already verified for a Request object built in this isolate (the hosted MCP server
 * replays tool calls through the API worker). Only code holding the exact Request instance can
 * register it, so nothing an external client sends, header or body, can mark a request verified.
 */
const verifiedRequests = new WeakMap<Request, VerifiedApikey>()

export function markInternalRequestVerified(request: Request, key: string, apikey: ApikeyRow) {
  verifiedRequests.set(request, { key, apikey })
}

/**
 * Returns the key row verified for this in-process request when the presented key is the one that
 * was verified and it has not expired since. Returns null for every request built outside this
 * isolate, so callers fall back to the normal lookup.
 */
export function getInternalVerifiedApikey(c: Context, key: string): ApikeyRow | null {
  const entry = verifiedRequests.get(c.req.raw)
  if (!entry || entry.key !== key)
    return null
  const expiresAt = entry.apikey.expires_at
  if (expiresAt && new Date(expiresAt) < new Date())
    return null
  return entry.apikey
}
