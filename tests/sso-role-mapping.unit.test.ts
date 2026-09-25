import { describe, expect, it } from 'vitest'

import { parseStoredRoleMapping, readRoleSourceValues, resolveSsoAccess, roleMappingSchema } from '../supabase/functions/_backend/private/sso/role-mapping.ts'

const ADMINS_GROUP = '00000000-0000-4000-8000-000000000001'
const MOBILE_GROUP = '00000000-0000-4000-8000-000000000002'

const mapping = roleMappingSchema.parse({
  attribute: 'groups',
  rules: [
    { value: 'capgo-admins', role: 'org_admin', group_id: ADMINS_GROUP },
    { value: 'capgo-devs', role: 'org_member' },
    { value: 'mobile', group_id: MOBILE_GROUP },
  ],
  default_role: null,
})

describe('resolveSsoAccess', () => {
  it('uses the first matching rule that grants a role', () => {
    expect(resolveSsoAccess(mapping, ['capgo-devs', 'capgo-admins']).role).toBe('org_admin')
  })

  it('collects groups from every matching rule', () => {
    const access = resolveSsoAccess(mapping, ['capgo-devs', 'mobile'])
    expect(access.role).toBe('org_member')
    expect(access.groupIds).toEqual([MOBILE_GROUP])
    expect(access.managedGroupIds).toEqual([ADMINS_GROUP, MOBILE_GROUP])
  })

  it('denies access when nothing grants a role and default_role is null', () => {
    expect(resolveSsoAccess(mapping, ['mobile'])).toMatchObject({ role: null, groupIds: [] })
    expect(resolveSsoAccess(mapping, [])).toMatchObject({ role: null, groupIds: [] })
  })

  it('falls back to default_role', () => {
    expect(resolveSsoAccess({ ...mapping, default_role: 'org_member' }, []).role).toBe('org_member')
  })
})

describe('role mapping parsing', () => {
  it('rejects rules granting nothing and unknown roles', () => {
    expect(roleMappingSchema.safeParse({ attribute: 'groups', rules: [{ value: 'x' }], default_role: null }).success).toBe(false)
    expect(roleMappingSchema.safeParse({ attribute: 'groups', rules: [], default_role: 'apikey_manager' }).success).toBe(false)
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
