import type { GoTrueSendEmailEvent } from '../utils/auth_email.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import {
  authEmailDeliveriesFromGoTrueEvent,
  buildAuthEmailBentoDetails,
  getAuthEmailBentoEvent,
} from '../utils/auth_email.ts'
import { isBentoConfigured, trackBentoEvent } from '../utils/bento.ts'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { getEnv } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const deliveries = authEmailDeliveriesFromGoTrueEvent(await parseBody<GoTrueSendEmailEvent>(c))
    .filter(item => item.payload.email_action_type)
  if (deliveries.length === 0)
    throw simpleError('invalid_payload', 'Invalid send_email payload')

  if (!isBentoConfigured(c)) {
    quickError(500, 'bento_not_configured', 'Bento is not configured for auth email delivery', {
      email_action_type: deliveries[0]?.payload.email_action_type,
    })
  }

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const webappUrl = getEnv(c, 'WEBAPP_URL')

  for (const delivery of deliveries) {
    const details = buildAuthEmailBentoDetails(delivery.payload, supabaseUrl, webappUrl)
    const eventName = getAuthEmailBentoEvent(delivery.payload.email_action_type)

    cloudlog({
      requestId: c.get('requestId'),
      message: 'send_email queue message',
      email_action_type: delivery.payload.email_action_type,
      event: eventName,
      has_confirmation_url: Boolean(details.confirmation_url),
      has_token: Boolean(details.token),
    })

    const result = await trackBentoEvent(c, delivery.email, { ...details }, eventName)
    if (result === false) {
      quickError(500, 'bento_auth_email_delivery_failed', 'Bento auth email delivery failed', {
        email_action_type: delivery.payload.email_action_type,
        event: eventName,
      })
    }
  }

  return c.json(BRES)
})
