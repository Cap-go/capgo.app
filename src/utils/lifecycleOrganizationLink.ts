interface AccessibleOrganization { gid: string, is_invite?: boolean, role: string }

// Email links select only an organization already present in the caller's
// authenticated membership list. They never accept invitations or grant access.
export function lifecycleOrganizationTarget(query: Record<string, unknown>, organizations: AccessibleOrganization[]): string | null | undefined {
  if (query.source !== 'capgo_lifecycle')
    return undefined
  if (typeof query.oid !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(query.oid))
    return null
  const org = organizations.find(item => item.gid === query.oid)
  return org && !org.is_invite && !org.role.startsWith('invite') ? org.gid : null
}
