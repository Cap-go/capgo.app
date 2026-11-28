import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { trackAffonsoSignup } from '../utils/affonso.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'

// Called by the console after sign-in when the visitor arrived through an affiliate
// link (affonso_referral cookie). Records the Affonso signup with the user's email.
export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<{ clickId?: unknown }>(c)
  const userId = c.get('auth')?.userId
  if (!userId)
    throw simpleError('not_authorized', 'Not authorized')
  // Only new accounts count as affiliate signups, like the pixel that ran at registration.
  const result = await trackAffonsoSignup(c, body.clickId, userId, { requireRecentAccount: true })
  if (result === 'invalid_click')
    throw simpleError('invalid_click_id', 'Invalid Affonso click id')
  return c.json({ status: result })
})
