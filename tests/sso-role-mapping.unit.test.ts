import { describe, expect, it } from 'vitest'

import { parseStoredRoleMapping, readRoleSourceValues, resolveSsoAccess, roleMappingSchema } from '../supabase/functions/_backend/private/sso/role-mapping.ts'

const ADMINS_GROUP = '00000000-0000-4000-8000-000000000001'
const APP_A = '00000000-0000-4000-8000-00000000000a'
const APP_B = '00000000-0000-4000-8000-00000000000b'

const mapping = roleMappingSchema.parse({
  attribute: 'groups',
  rules: [
    { value: 'team-a', org_role: 'org_member', apps: [{ app_id: APP_A, role: 'app_developer' }] },
    { value: 'team-a-leads', apps: [{ app_id: APP_A, role: 'app_admin' }] },
    { value: 'team-b', org_role: 'org_member', apps: [{ app_id: APP_B, role: 'app_admin' }] },
    { value: 'capgo-admins', org_role: 'org_admin', group_id: ADMINS_GROUP },
  ],
  default_role: null,
})

describe('resolveSsoAccess', () => {
  it('scopes app roles to the apps of the matching rules', () => {
    const access = resolveSsoAccess(mapping, ['team-a'])
    expect(access.orgRole).toBe('org_member')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_developer' })
    expect(access.managedAppIds).toEqual([APP_A, APP_B])
  })

  it('keeps the highest org and app role across matching rules', () => {
    const access = resolveSsoAccess(mapping, ['team-a', 'team-a-leads', 'team-b', 'capgo-admins'])
    expect(access.orgRole).toBe('org_admin')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_admin', [APP_B]: 'app_admin' })
    expect(access.groupIds).toEqual([ADMINS_GROUP])
  })

  it('denies access when nothing grants an org role and default_role is null', () => {
    expect(resolveSsoAccess(mapping, ['team-a-leads'])).toMatchObject({ orgRole: null, appRoles: {}, groupIds: [] })
    expect(resolveSsoAccess(mapping, [])).toMatchObject({ orgRole: null })
  })

  it('falls back to default_role and still applies app roles', () => {
    const access = resolveSsoAccess({ ...mapping, default_role: 'org_member' }, ['team-a-leads'])
    expect(access.orgRole).toBe('org_member')
    expect(access.appRoles).toEqual({ [APP_A]: 'app_admin' })
  })
})

describe('role mapping parsing', () => {
  it('rejects rules granting nothing and unknown roles', () => {
    expect(roleMappingSchema.safeParse({ attribute: 'groups', rules: [{ value: 'x' }], default_role: null }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ attribute: 'groups', rules: [], default_role: 'apikey_manager' }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ attribute: 'groups', rules: [{ value: 'x', apps: [{ app_id: APP_A, role: 'org_admin' }] }], default_role: null }).success).toBe(false)
  })

  it('treats invalid stored mappings as absent', () => {
    expect(parseStoredRoleMapping({ nope: true })).toBeNull()
    expect(parseStoredRoleMapping(null)).toBeNull()
  })

  it('reads single and multi-valued claims', () => {
    expect(readRoleSourceValues({ custom_claims: { capgo_role_source: ['a', ' b ', 3] } })).toEqual(['a', 'b'])
    expect(readRoleSourceValues({ custom_claims: { capgo_role_source: 'a' } })).toEqual(['a'])
    expect(readRoleSourceValues({})).toEqual([])
  })
})
