import { getLocalConfig } from '~/services/console'
import { pushEventForUser } from '~/services/posthog'

type OrganizationInvitationSuccessEvent
  = 'organization_membership_invitation_accepted'
    | 'organization_membership_invitation_declined'

type OrganizationInvitationEvent
  = OrganizationInvitationSuccessEvent
    | 'organization_membership_invitation_failed'
    | 'organization_membership_invitation_skipped'
    | 'organization_membership_invitation_viewed'

export type OrganizationInvitationFailureReason
  = 'acceptance_failed'
    | 'decline_failed'
    | 'invitation_not_found'
    | 'membership_update_failed'
    | 'unknown'

interface OrganizationInvitationEventInput {
  event: OrganizationInvitationEvent
  failureReason?: OrganizationInvitationFailureReason
  invitationId?: string
  pendingInvitationCount: number
  userId: string
}

interface TrackedOrganizationInvitationMutationInput {
  failureReason: Extract<OrganizationInvitationFailureReason, 'acceptance_failed' | 'decline_failed'>
  pendingInvitationCount: number
  successEvent: OrganizationInvitationSuccessEvent
  userId: string
}

const FAILURE_REASON_BY_CODE: Record<string, OrganizationInvitationFailureReason> = {
  FAILED_TO_ACCEPT_INVITATION: 'membership_update_failed',
  NO_INVITE: 'invitation_not_found',
  ROLE_NOT_FOUND: 'membership_update_failed',
}

function failureCode(error: unknown): string {
  if (typeof error === 'string')
    return error.trim().toUpperCase()

  if (!error || typeof error !== 'object')
    return ''

  const record = error as { code?: unknown, error?: unknown, message?: unknown }
  const candidate = record.error ?? record.code ?? record.message
  return typeof candidate === 'string' ? candidate.trim().toUpperCase() : ''
}

export function sanitizeOrganizationInvitationClientFailureReason(
  error: unknown,
  fallback: OrganizationInvitationFailureReason = 'unknown',
): OrganizationInvitationFailureReason {
  return FAILURE_REASON_BY_CODE[failureCode(error)] ?? fallback
}

function invitationInsertId(event: OrganizationInvitationSuccessEvent, userId: string, invitationId: string): string {
  return `organization-invitation:${event}:authenticated_pending_invite:${userId}:${invitationId}`
}

export function captureOrganizationInvitationEvent(input: OrganizationInvitationEventInput): void {
  try {
    pushEventForUser(
      input.event,
      input.userId,
      getLocalConfig().supaHost,
      {
        ...(input.invitationId && (input.event === 'organization_membership_invitation_accepted' || input.event === 'organization_membership_invitation_declined')
          ? { $insert_id: invitationInsertId(input.event, input.userId, input.invitationId) }
          : {}),
        account_state: 'already_existed',
        entry_path: '/onboarding/invitation',
        ...(input.failureReason ? { failure_reason: input.failureReason } : {}),
        flow: 'authenticated_pending_invite',
        pending_invitation_count: input.pendingInvitationCount,
      },
    )
  }
  catch {
    // Invitation actions must never depend on analytics availability.
  }
}

export async function runTrackedOrganizationInvitationMutation(
  input: TrackedOrganizationInvitationMutationInput,
  mutation: () => Promise<string>,
): Promise<void> {
  let invitationId: string
  try {
    invitationId = await mutation()
  }
  catch (error) {
    captureOrganizationInvitationEvent({
      event: 'organization_membership_invitation_failed',
      failureReason: sanitizeOrganizationInvitationClientFailureReason(error, input.failureReason),
      pendingInvitationCount: input.pendingInvitationCount,
      userId: input.userId,
    })
    throw error
  }

  captureOrganizationInvitationEvent({
    event: input.successEvent,
    invitationId,
    pendingInvitationCount: input.pendingInvitationCount,
    userId: input.userId,
  })
}
