import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { middlewareAPISecret, quickError } from '../utils/hono.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, () => {
  quickError(500, 'cloudflare_required', 'Auth email delivery requires the Cloudflare Worker')
})
