import { invokeCapgoApi } from '~/services/capgoApi'

// Access the SSO role mapping rewrites on every login of an SSO member: their
// org role, their roles on the apps their provider maps and their membership
// of the groups it maps. A manual edit of these would be reverted at the next
// login, so the UI locks them.
export interface SsoManagedUser {
  appIds: Set<string>
  groupIds: Set<string>
}

export type SsoManagedAccess = Map<string, SsoManagedUser>

// Best effort: if the lookup fails nothing is locked. `appId` (public app id)
// lets app role editors without org.read_members read it for their app.
export async function fetchSsoManagedAccess(orgId: string, appId?: string): Promise<SsoManagedAccess> {
  const query = appId ? `?app_id=${encodeURIComponent(appId)}` : ''
  const { data, error } = await invokeCapgoApi<{ users: Record<string, { app_ids: string[], group_ids: string[] }> }>(
    `private/sso/providers/${orgId}/managed${query}`,
    { method: 'GET' },
  )
  if (error || !data) {
    console.error('Failed to load SSO managed access:', error)
    return new Map()
  }
  return new Map(Object.entries(data.users).map(([userId, user]) => [userId, { appIds: new Set(user.app_ids), groupIds: new Set(user.group_ids) }]))
}
