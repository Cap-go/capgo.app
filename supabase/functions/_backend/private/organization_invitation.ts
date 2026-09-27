import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { captureOrganizationInvitationPosthogEvent } from '../utils/organization_invitation_posthog.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

const magicLookupSchema = z.object({
  magic_invite_string: z.string().min(1).max(512),
})

type MagicInvitationLookup = Database['public']['Functions']['get_invite_by_magic_lookup']['Returns'][number]

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.post('/magic-lookup', async (c) => {
  const validation = safeParseSchema(magicLookupSchema, await parseBody(c))
  if (!validation.success)
    throw simpleError('invalid_json_body', 'Invalid request')

  const magicInviteString = validation.data.magic_invite_string
  const adminClient = supabaseAdmin(c)
  const { data: invitationData, error: invitationDataError } = await adminClient
    .rpc('get_invite_by_magic_lookup', { lookup: magicInviteString })
    .maybeSingle()

  if (invitationDataError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to load magic-link invitation details',
      error: invitationDataError,
    })
    return quickError(500, 'failed_to_load_invitation', 'Failed to load invitation')
  }
  if (!invitationData)
    return quickError(404, 'invitation_not_found', 'Invitation not found')

  const invitation = invitationData as MagicInvitationLookup
  const { data: invitationIdentity, error: invitationIdentityError } = await adminClient
    .from('tmp_users')
    .select('future_uuid, email')
    .eq('invite_magic_string', magicInviteString)
    .maybeSingle()

  if (invitationIdentityError || !invitationIdentity) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve magic-link invitation telemetry identity',
      error: invitationIdentityError,
    })
    return c.json(invitation)
  }

  const { data: existingUser, error: existingUserError } = await adminClient
    .from('users')
    .select('id')
    .eq('email', invitationIdentity.email)
    .maybeSingle()

  if (existingUserError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve magic-link invitation account state',
      error: existingUserError,
    })
  }
  else {
    try {
      await captureOrganizationInvitationPosthogEvent(c, {
        event: 'organization_membership_invitation_viewed',
        flow: 'new_user_magic_link',
        pendingInvitationCount: 1,
        userId: existingUser?.id ?? invitationIdentity.future_uuid,
      })
    }
    catch {
      // Invitation lookup must never depend on analytics availability.
    }
  }

  return c.json(invitation)
})
