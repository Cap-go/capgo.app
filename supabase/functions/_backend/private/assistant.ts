import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { bodyLimit } from 'hono/body-limit'
import { honoFactory, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'

export const app = honoFactory.createApp()

app.use('*', useCors)
app.use('*', middlewareAuth())
app.use('*', async (c, next) => {
  const auth = c.get('auth')
  if (!auth?.userId || auth.authType !== 'jwt' || auth.claims?.role !== 'authenticated')
    throw quickError(401, 'not_authorized', 'Assistant requests require a signed-in console session')
  c.header('Cache-Control', 'no-store')
  await next()
})
app.use('*', bodyLimit({
  maxSize: 1024 * 1024,
  onError: () => quickError(413, 'request_too_large', 'Assistant request exceeds the size limit'),
}))

async function proxy(c: Context<MiddlewareKeyVariables>, path: 'models' | 'responses') {
  const token = c.req.header('x-chatgpt-token')
  if (!token || token.length > 16_384 || /\s/.test(token))
    throw quickError(400, 'invalid_chatgpt_token', 'A ChatGPT access token is required')

  let body: string | undefined
  if (path === 'responses') {
    const mediaType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
    if (mediaType !== 'application/json')
      throw quickError(415, 'invalid_content_type', 'Assistant requests require JSON')
    let payload: unknown
    try {
      payload = await c.req.json()
    }
    catch {
      throw quickError(400, 'invalid_json_body', 'Invalid assistant request')
    }
    if (!payload || typeof payload !== 'object' || !('store' in payload) || payload.store !== false || !('stream' in payload) || payload.stream !== true)
      throw quickError(400, 'invalid_assistant_request', 'Assistant requests require store: false and stream: true')
    body = JSON.stringify(payload)
  }

  let upstream: Response
  try {
    upstream = await fetch(`https://api.openai.com/v1/${path}`, {
      method: path === 'models' ? 'GET' : 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': path === 'models' ? 'application/json' : 'text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(path === 'models' ? 10_000 : 90_000)]),
    })
  }
  catch {
    throw quickError(502, 'assistant_upstream_error', 'Cannot reach OpenAI')
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel()
    throw quickError(502, 'assistant_upstream_error', 'Unexpected OpenAI redirect')
  }

  const headers = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value)
      headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

app.get('/models', c => proxy(c, 'models'))
app.post('/responses', c => proxy(c, 'responses'))
