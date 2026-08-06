import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { FunctionsHttpError } from '@supabase/supabase-js'

export interface CapgoApiInvokeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: BodyInit | Record<string, unknown> | null
  headers?: Record<string, string>
  /** Use the anon key when there is no user session (public bootstrap endpoints). */
  allowAnonymous?: boolean
  /** Prefer caller-provided client for session/auth context. */
  client?: SupabaseClient<Database>
}

function normalizeApiHost(host: string | undefined): string {
  return (host ?? '').replace(/\/+$/, '')
}

function parseHostname(supaHost: string): string | null {
  try {
    const withProtocol = /:\/\//.test(supaHost) ? supaHost : `https://${supaHost}`
    return new URL(withProtocol).hostname.toLowerCase()
  }
  catch {
    return null
  }
}

/** Capgo-managed Supabase hosts (cloud). Match hostname exactly. */
export function isCapgoManagedSupabaseHost(supaHost?: string): boolean {
  const hostname = supaHost ? parseHostname(supaHost) : null
  if (!hostname)
    return false
  return hostname === 'sb.capgo.app'
    || hostname === 'xvwzpoazmxkqosrdewyv.supabase.co'
    || hostname === 'ibwjdnhknbkcqfbabwei.supabase.co'
    || hostname === 'aucsybvnhavogdmzwtcw.supabase.co'
}

function serializeBody(body: CapgoApiInvokeOptions['body']): BodyInit | undefined {
  if (body == null)
    return undefined
  if (
    typeof body === 'string'
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
  ) {
    return body as BodyInit
  }
  return JSON.stringify(body)
}

function isPostgresUniqueViolation(message: string): boolean {
  return message.includes('23505')
    || /duplicate key value violates unique constraint/i.test(message)
}

/** Prefer Postgres unique-violation codes nested under Capgo API `moreInfo`. */
export async function getCapgoApiErrorCode(error: unknown): Promise<string | undefined> {
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    const body = await error.context.clone().json().catch(() => null) as {
      code?: string
      error?: string
      moreInfo?: { code?: string, error?: unknown }
    } | null
    const nestedCode = body?.moreInfo?.code
    if (typeof nestedCode === 'string')
      return nestedCode
    const nestedError = body?.moreInfo?.error
    if (typeof nestedError === 'string' && isPostgresUniqueViolation(nestedError))
      return '23505'
    if (typeof body?.code === 'string')
      return body.code
    if (typeof body?.error === 'string')
      return body.error
  }
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Call Capgo Cloudflare API with the same { data, error } shape as
 * supabase.functions.invoke. Capgo cloud console traffic uses VITE_API_HOST.
 * Self-host / local keep supabase.functions.invoke → /functions/v1.
 */
export async function invokeCapgoApi<T = any>(
  path: string,
  options: CapgoApiInvokeOptions = {},
): Promise<{ data: T | null, error: Error | null }> {
  const { getLocalConfig, useSupabase } = await import('./supabase')
  const supabase = options.client ?? useSupabase()
  const config = getLocalConfig()

  if (!isCapgoManagedSupabaseHost(config.supaHost)) {
    const { allowAnonymous: _allowAnonymous, client: _client, ...invokeOptions } = options
    return supabase.functions.invoke(path, {
      method: invokeOptions.method,
      body: invokeOptions.body ?? undefined,
      headers: invokeOptions.headers,
    })
  }

  const method = (options.method ?? 'POST').toUpperCase()
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  }

  const hasAuthHeader = Object.keys(headers).some(key => key.toLowerCase() === 'authorization')
  if (!hasAuthHeader) {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    else if (options.allowAnonymous) {
      headers.Authorization = `Bearer ${config.supaKey}`
    }
    else {
      return {
        data: null,
        error: new Error('Not authenticated'),
      }
    }
  }

  const body = serializeBody(options.body)
  const hasContentType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type')
  if (body != null && !hasContentType && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json'

  const apiHost = normalizeApiHost(import.meta.env.VITE_API_HOST as string)
  const url = `${apiHost}/${path.replace(/^\//, '')}`

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    })

    if (!response.ok) {
      return {
        data: null,
        error: new FunctionsHttpError(response),
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null)

    return {
      data: payload as T,
      error: null,
    }
  }
  catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}
