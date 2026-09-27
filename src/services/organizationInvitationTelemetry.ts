import { pushEventForUser } from '~/services/posthog'
import { getLocalConfig } from '~/services/supabase'

export function captureOrganizationInvitationSkipped(userId: string, pendingInvitationCount: number): void {
  pushEventForUser(
    'organization_membership_invitation_skipped',
    userId,
    getLocalConfig().supaHost,
    {
      account_state: 'already_existed',
      entry_path: '/onboarding/invitation',
      flow: 'authenticated_pending_invite',
      pending_invitation_count: pendingInvitationCount,
    },
  )
}
