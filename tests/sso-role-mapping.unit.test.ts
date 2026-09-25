import { describe, expect, it } from 'vitest'

import { mappedAttributes, parseStoredRoleMapping, readAttributeValues, resolveSsoAccess, roleMappingSchema, ssoAttributeClaimKey } from '../supabase/functions/_backend/private/sso/role-mapping.ts'

const ADMINS_GROUP = '00000000-0000-4000-8000-000000000001'
const APP_A = '00000000-0000-4000-8000-00000000000a'
const APP_B = '00000000-0000-4000-8000-00000000000b'

// Two IdP attributes, as sent by e.g. KeyHub: a role and a list of groups.
const mapping = roleMappingSchema.parse({
  rules: [
    { attribute: 'groups', value: 'team-a', org_role: 'org_member', apps: [{ app_id: APP_A, role: 'app_developer' }] },
    { attribute: 'role', value: 'lead', apps: [{ app_id: APP_A, role: 'app_admin' }] },
    { attribute: 'groups', value: 'team-b', org_role: 'org_member', apps: [{ app_id: APP_B, role: 'app_admin' }] },
    { attribute: 'role', value: 'admin', org_role: 'org_admin', group_id: ADMINS_GROUP },
  ],
  default_role: null,
})

describe('resolveSsoAccess', () => {
  it('scopes app roles to the apps of the matching rules', () => {
    const access = resolveSsoAccess(mapping, { groups: ['team-a'] })
    expect(access.orgRole).toBe('org_member')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_developer' })
    expect(access.managedAppIds).toEqual([APP_A, APP_B])
  })

  it('combines rules on different attributes and keeps the highest roles', () => {
    const access = resolveSsoAccess(mapping, { groups: ['team-a', 'team-b'], role: ['lead', 'admin'] })
    expect(access.orgRole).toBe('org_admin')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_admin', [APP_B]: 'app_admin' })
    expect(access.groupIds).toEqual([ADMINS_GROUP])
  })

  it('only matches a value on the attribute of the rule', () => {
    expect(resolveSsoAccess(mapping, { role: ['team-a'] }).orgRole).toBeNull()
  })

  it('denies access when nothing grants an org role and default_role is null', () => {
    expect(resolveSsoAccess(mapping, { role: ['lead'] })).toMatchObject({ orgRole: null, appRoles: {}, groupIds: [] })
    expect(resolveSsoAccess(mapping, {})).toMatchObject({ orgRole: null })
  })

  it('falls back to default_role and still applies app roles', () => {
    const access = resolveSsoAccess({ ...mapping, default_role: 'org_member' }, { role: ['lead'] })
    expect(access.orgRole).toBe('org_member')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_admin' })
  })
})

describe('role mapping parsing', () => {
  it('rejects rules granting nothing, missing attributes and unknown roles', () => {
    expect(roleMappingSchema.safeParse({ rules: [{ attribute: 'groups', value: 'x' }], default_role: null }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ rules: [{ value: 'x', org_role: 'org_member' }], default_role: null }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ rules: [], default_role: 'apikey_manager' }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ rules: [{ attribute: 'groups', value: 'x', apps: [{ app_id: APP_A, role: 'org_admin' }] }], default_role: null }).success).toBe(false)
  })

  it('treats invalid stored mappings as absent', () => {
    expect(parseStoredRoleMapping({ nope: true })).toBeNull()
    expect(parseStoredRoleMapping(null)).toBeNull()
  })

  it('reads each mapped attribute from its own claim', () => {
    expect(mappedAttributes(mapping)).toEqual(['groups', 'role'])
    const claims = {
      [ssoAttributeClaimKey('groups')]: ['a', ' b ', 3],
      [ssoAttributeClaimKey('role')]: 'lead',
    }
    expect(readAttributeValues({ custom_claims: claims }, ['groups', 'role', 'missing'])).toEqual({ groups: ['a', 'b'], role: ['lead'], missing: [] })
  })

  it('derives stable, distinct, safe claim keys', () => {
    const groupsKey = ssoAttributeClaimKey('http://schemas.microsoft.com/ws/2008/06/identity/claims/groups')
    expect(groupsKey).toMatch(/^capgo_attr_[0-9a-f]+$/)
    expect(ssoAttributeClaimKey('http://schemas.microsoft.com/ws/2008/06/identity/claims/groups')).toBe(groupsKey)
    expect(ssoAttributeClaimKey('role')).not.toBe(ssoAttributeClaimKey('groups'))
  })
})
