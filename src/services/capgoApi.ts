import { FunctionsHttpError } from '@supabase/supabase-js'

export interface CapgoApiInvokeOptions {
  method?: string
  body?: BodyInit | Record<string, unknown> | null
  headers?: Record<string, string>
}

function normalizeApiHost(host: string): string {
  return host.replace(/\/+$/, '')
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
 * supabase.functions.invoke. Capgo cloud console traffic must not use
 * sb.capgo.app edge functions.
 */
export async function invokeCapgoApi<T = any>(
  path: string,
  options: CapgoApiInvokeOptions = {},
): Promise<{ data: T | null, error: Error | null }> {
  const { useSupabase } = await import('./supabase')
  const supabase = useSupabase()
  const method = (options.method ?? 'POST').toUpperCase()
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  }

  const hasAuthHeader = Object.keys(headers).some(key => key.toLowerCase() === 'authorization')
  if (!hasAuthHeader) {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    if (!token) {
      return {
        data: null,
        error: new Error('Not authenticated'),
      }
    }
    headers.Authorization = `Bearer ${token}`
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

    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null)

    if (!response.ok) {
      return {
        data: null,
        error: new FunctionsHttpError(response),
      }
    }

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
