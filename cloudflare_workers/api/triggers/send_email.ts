import type { GoTrueSendEmailEvent } from '../../../supabase/functions/_backend/utils/auth_email.ts'
import type { MiddlewareKeyVariables } from '../../../supabase/functions/_backend/utils/hono.ts'
import { Hono } from 'hono/tiny'
import {
  authEmailDeliveriesFromGoTrueEvent,
  buildAuthEmailTemplateDetails,
} from '../../../supabase/functions/_backend/utils/auth_email.ts'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../../../supabase/functions/_backend/utils/hono.ts'
import { cloudlog } from '../../../supabase/functions/_backend/utils/logging.ts'
import { getEnv } from '../../../supabase/functions/_backend/utils/utils.ts'
import { isAuthEmailAction, renderAuthEmail } from '../email_templates/index.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const emailBinding = c.env?.AUTH_EMAIL
  if (!emailBinding)
    quickError(500, 'cloudflare_email_unavailable', 'Cloudflare Email Sending is unavailable')

  const deliveries = authEmailDeliveriesFromGoTrueEvent(await parseBody<GoTrueSendEmailEvent>(c))
  if (deliveries.length === 0)
    throw simpleError('invalid_payload', 'Invalid send_email payload')

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const webappUrl = getEnv(c, 'WEBAPP_URL')

  // Render every message before sending so a bad second email cannot cause a partial delivery.
  const messages = deliveries.map(({ email, payload }) => {
    if (!isAuthEmailAction(payload.email_action_type))
      simpleError('unsupported_email_action', 'Unsupported auth email action')

    const details = buildAuthEmailTemplateDetails(payload, supabaseUrl, webappUrl)
    let content: ReturnType<typeof renderAuthEmail>
    try {
      content = renderAuthEmail(payload.email_action_type, details)
    }
    catch (error) {
      quickError(500, 'invalid_auth_email_template', 'Auth email template could not be rendered', {
        email_action_type: payload.email_action_type,
      }, error)
    }

    return { email, action: payload.email_action_type, content }
  })

  for (const { email, action, content } of messages) {
    try {
      const result = await emailBinding.send({
        to: email,
        from: 'noreply@capgo.app',
        ...content,
      })
      cloudlog({
        requestId: c.get('requestId'),
        message: 'auth email sent with Cloudflare',
        email_action_type: action,
        messageId: result.messageId,
      })
    }
    catch (error) {
      quickError(500, 'cloudflare_auth_email_delivery_failed', 'Cloudflare auth email delivery failed', {
        email_action_type: action,
      }, error)
    }
  }

  return c.json(BRES)
})
