import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { BRES, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr } from '../utils/logging.ts'
import {
  captureOrganizationInvitationPosthogEvent,
  sanitizeOrganizationInvitationFailureReason,
} from '../utils/organization_invitation_posthog.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { supabaseAdmin, supabaseWithAuth } from '../utils/supabase.ts'

const magicViewSchema = z.object({
  magic_invite_string: z.string().min(1),
})

const authenticatedActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('view') }),
  z.object({ action: z.literal('accept'), org_id: z.uuid() }),
  z.object({ action: z.literal('decline'), org_id: z.uuid() }),
  z.object({ action: z.literal('decline_all'), org_ids: z.array(z.uuid()).min(1).max(100) }),
])

type AuthenticatedAction = z.infer<typeof authenticatedActionSchema>
type AuthenticatedClient = ReturnType<typeof supabaseWithAuth>
type PendingMembership = Pick<Database['public']['Tables']['org_users']['Row'], 'id'>

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

async function getPendingInvitationCount(c: Parameters<typeof supabaseWithAuth>[0], client: AuthenticatedClient) {
  const { data, error } = await client.rpc('get_orgs_v7')
  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to count pending organization invitations for telemetry',
      error,
    })
    return undefined
  }

  return data.filter(organization => organization.is_invite).length
}

async function getPendingMembership(client: AuthenticatedClient, userId: string, orgId: string): Promise<PendingMembership | null> {
  const { data } = await client
    .from('org_users')
    .select('id')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .eq('is_invite', true)
    .maybeSingle()

  return data
}

app.post('/magic-view', async (c) => {
  const validation = safeParseSchema(magicViewSchema, await parseBody(c))
  if (!validation.success)
    throw simpleError('invalid_json_body', 'Invalid request')

  const adminClient = supabaseAdmin(c)
  const { data: invitation, error: invitationError } = await adminClient
    .from('tmp_users')
    .select('id, future_uuid, email, cancelled_at')
    .eq('invite_magic_string', validation.data.magic_invite_string)
    .maybeSingle()

  if (invitationError)
    return quickError(500, 'failed_to_load_invitation', 'Failed to load invitation')
  if (!invitation || invitation.cancelled_at)
    return quickError(404, 'invitation_not_found', 'Invitation not found')

  const { data: existingUser, error: existingUserError } = await adminClient
    .from('users')
    .select('id')
    .eq('email', invitation.email)
    .maybeSingle()

  if (existingUserError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve magic-link invitation telemetry identity',
      error: existingUserError,
    })
    return c.json(BRES)
  }

  await captureOrganizationInvitationPosthogEvent(c, {
    event: 'organization_membership_invitation_viewed',
    flow: 'new_user_magic_link',
    pendingInvitationCount: 1,
    userId: existingUser?.id ?? invitation.future_uuid,
  })

  return c.json(BRES)
})

app.post('/', middlewareAuth, async (c) => {
  const auth = c.get('auth')
  if (!auth?.userId || auth.authType !== 'jwt')
    return quickError(401, 'unauthorized', 'Unauthorized')

  const validation = safeParseSchema(authenticatedActionSchema, await parseBody(c))
  if (!validation.success)
    throw simpleError('invalid_json_body', 'Invalid request')

  const action: AuthenticatedAction = validation.data
  const client = supabaseWithAuth(c, auth)
  const pendingInvitationCount = await getPendingInvitationCount(c, client)

  if (action.action === 'view') {
    if (!pendingInvitationCount)
      return c.json(BRES)

    await captureOrganizationInvitationPosthogEvent(c, {
      accountState: 'already_existed',
      event: 'organization_membership_invitation_viewed',
      flow: 'authenticated_pending_invite',
      pendingInvitationCount,
      userId: auth.userId,
    })
    return c.json(BRES)
  }

  if (action.action === 'decline_all') {
    const { data: deletedInvitations, error } = await client
      .from('org_users')
      .delete()
      .eq('user_id', auth.userId)
      .eq('is_invite', true)
      .in('org_id', action.org_ids)
      .select('id')

    if (error || !deletedInvitations?.length) {
      await captureOrganizationInvitationPosthogEvent(c, {
        accountState: 'already_existed',
        event: 'organization_membership_invitation_failed',
        failureReason: sanitizeOrganizationInvitationFailureReason(error, error ? 'decline_failed' : 'invitation_not_found'),
        flow: 'authenticated_pending_invite',
        pendingInvitationCount,
        userId: auth.userId,
      })
      return quickError(error ? 500 : 404, 'failed_to_decline_invitation', 'Failed to decline invitation')
    }

    await Promise.all(deletedInvitations.map(invitation => captureOrganizationInvitationPosthogEvent(c, {
      accountState: 'already_existed',
      event: 'organization_membership_invitation_declined',
      flow: 'authenticated_pending_invite',
      invitationId: invitation.id,
      pendingInvitationCount,
      userId: auth.userId,
    })))
    return c.json(BRES)
  }

  const pendingMembership = await getPendingMembership(client, auth.userId, action.org_id)

  if (action.action === 'accept') {
    const { data, error } = await client.rpc('accept_invitation_to_org', {
      org_id: action.org_id,
    })

    if (error || data !== 'OK') {
      await captureOrganizationInvitationPosthogEvent(c, {
        accountState: 'already_existed',
        event: 'organization_membership_invitation_failed',
        failureReason: sanitizeOrganizationInvitationFailureReason(error ?? data, 'acceptance_failed'),
        flow: 'authenticated_pending_invite',
        pendingInvitationCount,
        userId: auth.userId,
      })
      return quickError(409, 'failed_to_accept_invitation', 'Failed to accept invitation')
    }

    await captureOrganizationInvitationPosthogEvent(c, {
      accountState: 'already_existed',
      event: 'organization_membership_invitation_accepted',
      flow: 'authenticated_pending_invite',
      invitationId: pendingMembership?.id ?? action.org_id,
      pendingInvitationCount,
      userId: auth.userId,
    })
    return c.json(BRES)
  }

  const { data: deletedInvitations, error } = await client
    .from('org_users')
    .delete()
    .eq('user_id', auth.userId)
    .eq('org_id', action.org_id)
    .eq('is_invite', true)
    .select('id')

  if (error || !deletedInvitations?.length) {
    await captureOrganizationInvitationPosthogEvent(c, {
      accountState: 'already_existed',
      event: 'organization_membership_invitation_failed',
      failureReason: sanitizeOrganizationInvitationFailureReason(error, error ? 'decline_failed' : 'invitation_not_found'),
      flow: 'authenticated_pending_invite',
      pendingInvitationCount,
      userId: auth.userId,
    })
    return quickError(error ? 500 : 404, 'failed_to_decline_invitation', 'Failed to decline invitation')
  }

  await captureOrganizationInvitationPosthogEvent(c, {
    accountState: 'already_existed',
    event: 'organization_membership_invitation_declined',
    flow: 'authenticated_pending_invite',
    invitationId: deletedInvitations[0].id,
    pendingInvitationCount,
    userId: auth.userId,
  })
  return c.json(BRES)
})
