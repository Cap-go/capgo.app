import type { Context } from 'hono'
import { cloudlogErr } from './logging.ts'
import { trackPosthogEvent } from './posthog.ts'

export type OrganizationInvitationFlow = 'authenticated_pending_invite' | 'new_user_magic_link'
export type OrganizationInvitationAccountState = 'already_existed' | 'created'
export type OrganizationInvitationEvent
  = 'organization_membership_invitation_accepted'
    | 'organization_membership_invitation_declined'
    | 'organization_membership_invitation_failed'
    | 'organization_membership_invitation_viewed'

export type OrganizationInvitationFailureReason
  = 'acceptance_failed'
    | 'authentication_failed'
    | 'captcha_required'
    | 'decline_failed'
    | 'invalid_password'
    | 'invalid_request'
    | 'invitation_cancelled'
    | 'invitation_not_found'
    | 'membership_update_failed'
    | 'unknown'

interface OrganizationInvitationPosthogBaseInput {
  accountState?: OrganizationInvitationAccountState
  failureReason?: OrganizationInvitationFailureReason
  flow: OrganizationInvitationFlow
  pendingInvitationCount?: number
  userId: string
}

type OrganizationInvitationPosthogInput
  = | OrganizationInvitationPosthogBaseInput & {
    event: Extract<OrganizationInvitationEvent, 'organization_membership_invitation_accepted' | 'organization_membership_invitation_declined'>
    invitationId: number | string
  }
  | OrganizationInvitationPosthogBaseInput & {
    event: Extract<OrganizationInvitationEvent, 'organization_membership_invitation_failed' | 'organization_membership_invitation_viewed'>
    invitationId?: never
  }

const ENTRY_PATH_BY_FLOW: Record<OrganizationInvitationFlow, string> = {
  authenticated_pending_invite: '/onboarding/invitation',
  new_user_magic_link: '/invitation',
}

const FAILURE_REASON_BY_CODE: Record<string, OrganizationInvitationFailureReason> = {
  FAILED_TO_ACCEPT_INVITATION: 'membership_update_failed',
  INVALID_JSON_BODY: 'invalid_request',
  INVALID_JSON_PARSE_BODY: 'invalid_request',
  INVALID_PASSWORD: 'invalid_password',
  INVALID_REQUEST: 'invalid_request',
  INVITATION_CANCELLED: 'invitation_cancelled',
  INVITATION_NOT_FOUND: 'invitation_not_found',
  NO_INVITE: 'invitation_not_found',
  ROLE_NOT_FOUND: 'membership_update_failed',
  SIGN_IN_FAILED: 'authentication_failed',
  USER_ALREADY_EXISTS: 'authentication_failed',
}

function failureCode(error: unknown): string {
  if (typeof error === 'string')
    return error.trim().toUpperCase()

  if (!error || typeof error !== 'object')
    return ''

  const record = error as {
    cause?: { error?: unknown }
    code?: unknown
    error?: unknown
  }
  const candidate = record.cause?.error ?? record.error ?? record.code
  return typeof candidate === 'string' ? candidate.trim().toUpperCase() : ''
}

export function sanitizeOrganizationInvitationFailureReason(
  error: unknown,
  fallback: OrganizationInvitationFailureReason = 'unknown',
): OrganizationInvitationFailureReason {
  return FAILURE_REASON_BY_CODE[failureCode(error)] ?? fallback
}

export async function organizationInvitationInsertId(input: {
  event: Extract<OrganizationInvitationEvent, 'organization_membership_invitation_accepted' | 'organization_membership_invitation_declined'>
  flow: OrganizationInvitationFlow
  invitationId: number | string
  userId: string
}): Promise<string> {
  const material = JSON.stringify([input.event, input.flow, input.userId, String(input.invitationId)])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  const digestHex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `organization-invitation:${digestHex}`
}

export async function captureOrganizationInvitationPosthogEvent(
  c: Context,
  input: OrganizationInvitationPosthogInput,
): Promise<boolean> {
  try {
    let insertId: string | undefined
    if (
      input.invitationId !== undefined
      && (input.event === 'organization_membership_invitation_accepted'
        || input.event === 'organization_membership_invitation_declined')
    ) {
      insertId = await organizationInvitationInsertId({
        event: input.event,
        flow: input.flow,
        invitationId: input.invitationId,
        userId: input.userId,
      })
    }

    return await trackPosthogEvent(c, {
      channel: 'organization-invitation',
      event: input.event,
      nonPersonTags: {
        ...(input.accountState ? { account_state: input.accountState } : {}),
        entry_path: ENTRY_PATH_BY_FLOW[input.flow],
        ...(input.failureReason ? { failure_reason: input.failureReason } : {}),
        flow: input.flow,
        ...(input.pendingInvitationCount === undefined
          ? {}
          : { pending_invitation_count: input.pendingInvitationCount }),
        ...(insertId ? { $insert_id: insertId } : {}),
      },
      setPersonProperties: false,
      timeoutMs: 1000,
      user_id: input.userId,
    })
  }
  catch {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Organization invitation PostHog capture failed',
      event: input.event,
      userId: input.userId,
    })
    return false
  }
}
