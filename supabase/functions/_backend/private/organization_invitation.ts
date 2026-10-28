import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { ImagePathScope } from '../utils/storage.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { captureOrganizationInvitationPosthogEvent } from '../utils/organization_invitation_posthog.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJsonOne } from '../utils/pg_rls.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { createSignedImageUrl } from '../utils/storage.ts'

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
  const pg = await getPgClient(c)
  try {
    return await magicLookup(c, pg, magicInviteString)
  }
  finally {
    closeClient(c, pg)
  }
})

async function magicLookup(c: Context<MiddlewareKeyVariables>, pg: PgClient, magicInviteString: string) {
  let invitationData: MagicInvitationLookup | null = null
  try {
    invitationData = await queryJsonOne<MagicInvitationLookup>(
      pg,
      'SELECT * FROM public.get_invite_by_magic_lookup(lookup => $1) LIMIT 1',
      [magicInviteString],
    )
  }
  catch (invitationDataError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to load magic-link invitation details',
      error: invitationDataError,
    })
    return quickError(500, 'failed_to_load_invitation', 'Failed to load invitation')
  }
  if (!invitationData)
    return quickError(404, 'invitation_not_found', 'Invitation not found')

  const invitation = invitationData
  const invitationResponse = async (scope?: ImagePathScope) => {
    if (invitation.org_logo && URL.canParse(invitation.org_logo)) {
      return invitation
    }

    try {
      return {
        ...invitation,
        org_logo: await createSignedImageUrl(c, invitation.org_logo, scope) ?? '',
      }
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Failed to sign magic-link invitation organization logo',
        error,
      })
      return {
        ...invitation,
        org_logo: '',
      }
    }
  }
  let invitationIdentity: { future_uuid: string, email: string, org_id: string } | null = null
  let invitationIdentityError: unknown = null
  try {
    const { rows } = await pg.query<{ future_uuid: string, email: string, org_id: string }>(
      'SELECT future_uuid, email, org_id FROM public.tmp_users WHERE invite_magic_string = $1 LIMIT 1',
      [magicInviteString],
    )
    invitationIdentity = rows[0] ?? null
  }
  catch (error) {
    invitationIdentityError = error
  }

  if (invitationIdentityError || !invitationIdentity) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve magic-link invitation telemetry identity',
      error: invitationIdentityError,
    })
    return c.json(await invitationResponse())
  }

  const [
    { data: existingUser, error: existingUserError },
    { data: invitationOrganization, error: invitationOrganizationError },
  ] = await Promise.all([
    settle(pg.query<{ id: string }>('SELECT id FROM public.users WHERE email = $1 LIMIT 1', [invitationIdentity.email])),
    settle(pg.query<{ created_by: string }>('SELECT created_by FROM public.orgs WHERE id = $1', [invitationIdentity.org_id])),
  ])

  if (invitationOrganizationError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to resolve magic-link invitation organization logo owner',
      error: invitationOrganizationError,
    })
  }

  const responseData = await invitationResponse({
    orgId: invitationIdentity.org_id,
    ...(invitationOrganization?.created_by ? { userId: invitationOrganization.created_by } : {}),
  })

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

  return c.json(responseData)
}

async function settle<T>(query: Promise<{ rows: T[] }>): Promise<{ data: T | null, error: unknown }> {
  try {
    return { data: (await query).rows[0] ?? null, error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}
