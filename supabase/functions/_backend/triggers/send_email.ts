import type { GoTrueSendEmailEvent } from '../utils/auth_email.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import {
  authEmailPayloadFromGoTrueEvent,
  buildAuthEmailBentoDetails,
  getAuthEmailBentoEvent,
} from '../utils/auth_email.ts'
import { isBentoConfigured, trackBentoEvent } from '../utils/bento.ts'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getEnv } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const payload = authEmailPayloadFromGoTrueEvent(await parseBody<GoTrueSendEmailEvent>(c))
  if (!payload.email || !payload.email_action_type)
    throw simpleError('invalid_payload', 'Invalid send_email payload')

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
