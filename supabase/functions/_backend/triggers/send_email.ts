import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import {
  buildAuthEmailBentoDetails,
  getAuthEmailBentoEvent,
} from '../utils/auth_email.ts'
import { isBentoConfigured, trackBentoEvent } from '../utils/bento.ts'
import { BRES, middlewareAPISecret, quickError, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { getEnv } from '../utils/utils.ts'

const sendEmailPayloadSchema = z.object({
  email: z.email(),
  email_action_type: z.string().min(1),
  factor_type: z.string().optional(),
  new_email: z.string().optional(),
  old_email: z.string().optional(),
  redirect_to: z.string().optional(),
  site_url: z.string().optional(),
  token: z.string().optional(),
  token_hash: z.string().optional(),
})

export const app = new Hono<MiddlewareKeyVariables>()

function unwrapSendEmailPayload(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return body

  const record = body as Record<string, unknown>
  if (typeof record.email === 'string' && typeof record.email_action_type === 'string')
    return record

  if (record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload))
    return record.payload

  return record
}

app.post('/', middlewareAPISecret, async (c) => {
  const body = unwrapSendEmailPayload(await c.req.json())
  const parsed = safeParseSchema(sendEmailPayloadSchema, body)
  if (!parsed.success) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'send_email invalid payload',
      error: parsed.error.message,
    })
    throw simpleError('invalid_payload', 'Invalid send_email payload')
  }

  const payload = parsed.data
  const details = buildAuthEmailBentoDetails(
    payload,
    getEnv(c, 'SUPABASE_URL'),
    getEnv(c, 'WEBAPP_URL'),
  )
  const eventName = getAuthEmailBentoEvent(payload.email_action_type)

  cloudlog({
    requestId: c.get('requestId'),
    message: 'send_email queue message',
    email_action_type: payload.email_action_type,
    event: eventName,
    has_confirmation_url: Boolean(details.confirmation_url),
    has_token: Boolean(details.token),
  })

  if (!isBentoConfigured(c))
    return c.json(BRES)

  const result = await trackBentoEvent(c, payload.email, { ...details }, eventName)
  if (result === false) {
    quickError(500, 'bento_auth_email_delivery_failed', 'Bento auth email delivery failed', {
      email_action_type: payload.email_action_type,
      event: eventName,
    })
  }

  return c.json(BRES)
})
