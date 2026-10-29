import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { defaultApiHost, useConsole } from '~/services/console'

export interface HttpResult {
  status: number
  text: string
}

interface AssistantRequestInit {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

async function withSignal<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal)
    return promise
  let onAbort!: () => void
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        if (signal.aborted)
          onAbort()
        else
          signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  }
  finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function assistantOpenAIRequest(
  path: 'models' | 'responses',
  accessToken: string,
  init: AssistantRequestInit,
): Promise<HttpResult> {
  if (Capacitor.isNativePlatform()) {
    return assistantRequest(`https://api.openai.com/v1/${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
    })
  }
  const signal = init.signal ?? (init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined)
  const { data, error } = await withSignal(useConsole().auth.getSession(), signal)
  const sessionToken = data.session?.access_token
  if (error || !sessionToken)
    throw new Error('assistant_session_required')
  const response = await assistantRequest(`${defaultApiHost}/private/assistant/${path}`, {
    ...init,
    signal,
    headers: { ...init.headers, 'authorization': `Bearer ${sessionToken}`, 'x-chatgpt-token': accessToken },
  })
  if (response.status === 401) {
    let code: unknown
    try {
      code = JSON.parse(response.text).error
    }
    catch {}
    if (typeof code === 'string' && ['invalid_jwt', 'no_jwt_apikey_or_subkey', 'not_authorized'].includes(code))
      throw new Error('assistant_session_required')
  }
  return response
}

/**
 * Plain HTTP for the assistant. In the native app requests go through native HTTP (same as the Capgo
 * browser app): OpenAI's edge rejects some WebView origins and turns errors into an opaque "Load failed".
 */
export async function assistantRequest(
  url: string,
  init: AssistantRequestInit,
): Promise<HttpResult> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url,
      method: init.method,
      headers: init.headers,
      data: init.body,
      responseType: 'text',
      connectTimeout: init.timeoutMs,
      readTimeout: init.timeoutMs,
    })
    return { status: response.status, text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data) }
  }
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal ?? (init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined),
  })
  return { status: response.status, text: await response.text() }
}
