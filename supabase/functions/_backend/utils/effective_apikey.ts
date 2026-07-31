import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { simpleError } from './hono.ts'

type ApikeyRow = Database['public']['Tables']['apikeys']['Row']

export function getEffectiveApikey(
  c: Context<MiddlewareKeyVariables>,
  apikey: Pick<ApikeyRow, 'key'>,
): string | undefined {
  return apikey.key ?? c.get('capgkey') ?? undefined
}

export function requireEffectiveApikey(
  c: Context<MiddlewareKeyVariables>,
  apikey: Pick<ApikeyRow, 'key'>,
  errorCode: string,
  errorMessage: string,
  extra?: Record<string, unknown>,
): string {
  const effectiveApikey = getEffectiveApikey(c, apikey)
  if (!effectiveApikey)
    throw simpleError(errorCode, errorMessage, extra)
  return effectiveApikey
}
