import { FunctionsHttpError } from '@supabase/supabase-js'

export interface CapgoApiInvokeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: BodyInit | Record<string, unknown> | null
  headers?: Record<string, string>
  /** Use the anon key when there is no user session (public bootstrap endpoints). */
  allowAnonymous?: boolean
}

function normalizeApiHost(host: string | undefined): string {
  return (host ?? '').replace(/\/+$/, '')
}

/** Capgo-managed Supabase hosts (cloud). Self-host / local use a different origin. */
export function isCapgoManagedSupabaseHost(supaHost?: string): boolean {
  if (!supaHost)
    return false
  const host = normalizeApiHost(supaHost).toLowerCase()
  return host.includes('sb.capgo.app')
    || host.includes('xvwzpoazmxkqosrdewyv')
    || host.includes('ibwjdnhknbkcqfbabwei')
    || host.includes('aucsybvnhavogdmzwtcw')
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
  const supabase = useSupabase()
  const config = getLocalConfig()

  if (!isCapgoManagedSupabaseHost(config.supaHost)) {
    const { allowAnonymous: _allowAnonymous, ...invokeOptions } = options
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
