import { describe, expect, it } from 'vitest'
import { normalizeInviteRole } from '../supabase/functions/_backend/public/organization/members/post.ts'

describe('normalizeInviteRole', () => {
  it.concurrent('keeps RBAC role names unchanged', () => {
    expect(normalizeInviteRole('org_member')).toBe('org_member')
    expect(normalizeInviteRole('org_billing_admin')).toBe('org_billing_admin')
    expect(normalizeInviteRole('org_admin')).toBe('org_admin')
    expect(normalizeInviteRole('org_super_admin')).toBe('org_super_admin')
  })

  it.concurrent('maps previous invite_type values to RBAC roles', () => {
    expect(normalizeInviteRole('read')).toBe('org_member')
    expect(normalizeInviteRole('upload')).toBe('org_member')
    expect(normalizeInviteRole('write')).toBe('org_member')
    expect(normalizeInviteRole('admin')).toBe('org_admin')
    expect(normalizeInviteRole('super_admin')).toBe('org_super_admin')
    expect(normalizeInviteRole('invite_read')).toBe('org_member')
    expect(normalizeInviteRole('invite_upload')).toBe('org_member')
    expect(normalizeInviteRole('invite_write')).toBe('org_member')
    expect(normalizeInviteRole('invite_admin')).toBe('org_admin')
    expect(normalizeInviteRole('invite_super_admin')).toBe('org_super_admin')
  })

  it.concurrent('rejects unknown invite role names', () => {
    expect(normalizeInviteRole('owner')).toBeNull()
  })
})
