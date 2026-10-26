import type { Context } from 'hono'
import type { GoTrueSendEmailEvent } from '../../../supabase/functions/_backend/utils/auth_email.ts'
import type { MiddlewareKeyVariables } from '../../../supabase/functions/_backend/utils/hono.ts'
import { getRuntimeKey } from 'hono/adapter'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import {
  authEmailDeliveriesFromGoTrueEvent,
  buildAuthEmailTemplateDetails,
} from '../../../supabase/functions/_backend/utils/auth_email.ts'
import { BRES, middlewareAPISecret, parseBody, quickError, simpleError } from '../../../supabase/functions/_backend/utils/hono.ts'
import { getEnv } from '../../../supabase/functions/_backend/utils/utils.ts'
import { isAuthEmailAction, renderAuthEmail, selectAuthEmailTemplate } from '../email_templates/index.ts'
import { sendCloudflareEmail } from '../email_templates/send.ts'
import { startOrgInvitationBentoFlow, syncOrgInvitationBentoField } from './org_invitation_bento.ts'
import { sendOrgInvitationEmail } from './org_invitation_email.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const orgInvitationBentoSyncSchema = z.object({ email: z.string().trim().min(1).max(320) })

async function handleOrgInvitationBentoSync(c: Context<MiddlewareKeyVariables>, payload: unknown) {
  const recipient = orgInvitationBentoSyncSchema.safeParse(payload)
  if (!recipient.success)
    throw simpleError('invalid_payload', 'Invalid organization invitation Bento sync payload')
  try {
    await syncOrgInvitationBentoField(c, recipient.data.email)
  }
  catch (error) {
    quickError(500, 'org_invitation_bento_sync_failed', 'Organization invitation Bento sync failed', {}, error)
  }
  return c.json(BRES)
}

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<GoTrueSendEmailEvent & { org_invitation_id?: unknown, org_invitation_bento_sync?: unknown }>(c)
  if (body && typeof body === 'object' && Object.hasOwn(body, 'org_invitation_bento_sync'))
    return handleOrgInvitationBentoSync(c, body.org_invitation_bento_sync)

  const emailBinding = c.env?.AUTH_EMAIL
  if (!emailBinding)
    quickError(500, 'cloudflare_email_unavailable', 'Cloudflare Email Sending is unavailable')

  if (body && typeof body === 'object' && Object.hasOwn(body, 'org_invitation_id')) {
    const invitationId = z.uuid().safeParse(body.org_invitation_id)
    if (!invitationId.success)
      throw simpleError('invalid_payload', 'Invalid organization invitation email payload')
    try {
      // A queue retry after a Bento failure skips the already-sent email.
      // Bento enrollment is at least once: acceptance followed by a lost
      // response or failed marker commit can start a duplicate reminder flow.
      const delivery = sendOrgInvitationEmail(c, invitationId.data)
        .then(() => startOrgInvitationBentoFlow(c, invitationId.data))
      // Finish recording acceptance even if the queue's HTTP client times out.
      if (getRuntimeKey() === 'workerd')
        c.executionCtx.waitUntil(delivery.catch(() => {}))
      await delivery
    }
    catch (error) {
      quickError(500, 'cloudflare_org_invitation_email_failed', 'Cloudflare invitation email delivery failed', {
        invitationId: invitationId.data,
      }, error)
    }
    return c.json(BRES)
  }

  const deliveries = authEmailDeliveriesFromGoTrueEvent(body)
  if (deliveries.length === 0)
    throw simpleError('invalid_payload', 'Invalid send_email payload')

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const webappUrl = getEnv(c, 'WEBAPP_URL')

  // Render all recipient variants before sending so one invalid template cannot partially deliver the hook.
  const messages = deliveries.map(({ email, payload }) => {
    if (!isAuthEmailAction(payload.email_action_type))
      simpleError('unsupported_email_action', 'Unsupported auth email action')

    const details = buildAuthEmailTemplateDetails(payload, supabaseUrl, webappUrl)
    let content: ReturnType<typeof renderAuthEmail>
    try {
      const template = selectAuthEmailTemplate(payload.email_action_type, payload.redirect_to ?? '', details.site_url)
      content = renderAuthEmail(template, details)
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
      await sendCloudflareEmail(c, email, content, {
        email_action_type: action,
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
