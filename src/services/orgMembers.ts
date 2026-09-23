import { invokeCapgoApi } from '~/services/capgoApi'

export interface OrgMemberRbacRow {
  user_id: string
  email: string
  image_url: string | null
  role_name: string
  role_id: string
  binding_id: string
  granted_at: string
  is_invite: boolean
  is_tmp: boolean
  org_user_id: number | null
}

export interface MagicInviteLookup {
  org_name: string
  org_logo: string | null
  role: string
}

export async function fetchOrgMembersRbac(orgId: string) {
  const encodedOrgId = encodeURIComponent(orgId)
  return await invokeCapgoApi<OrgMemberRbacRow[]>(`private/org_members?org_id=${encodedOrgId}`, {
    method: 'GET',
  })
}

export async function inviteUserToOrgRbac(orgId: string, email: string, roleName: string) {
  return await invokeCapgoApi<{ code: string }>('private/org_members/invite', {
    method: 'POST',
    body: {
      org_id: orgId,
      email,
      role_name: roleName,
    },
  })
}

export async function rescindOrgInvitation(orgId: string, email: string) {
  return await invokeCapgoApi<{ code: string }>('private/org_members/rescind', {
    method: 'POST',
    body: {
      org_id: orgId,
      email,
    },
  })
}

export async function updateOrgMemberRole(orgId: string, userId: string, roleName: string) {
  return await invokeCapgoApi<{ status: 'ok' }>('private/org_members/member-role', {
    method: 'PATCH',
    body: {
      org_id: orgId,
      user_id: userId,
      role_name: roleName,
    },
  })
}

export async function updateOrgInviteRole(options: {
  orgId: string
  roleName: string
  isTmp: boolean
  userId?: string
  email?: string
}) {
  return await invokeCapgoApi<{ status: 'ok' }>('private/org_members/invite-role', {
    method: 'PATCH',
    body: {
      org_id: options.orgId,
      role_name: options.roleName,
      is_tmp: options.isTmp,
      user_id: options.userId,
      email: options.email,
    },
  })
}

export async function fetchMagicInviteLookup(lookup: string) {
  const encodedLookup = encodeURIComponent(lookup)
  return await invokeCapgoApi<MagicInviteLookup | null>(`private/org_members/magic-invite?lookup=${encodedLookup}`, {
    method: 'GET',
    allowAnonymous: true,
  })
}
