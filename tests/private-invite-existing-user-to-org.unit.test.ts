import { describe, expect, it } from 'vitest'
import { getInviteResendRequiredPermission } from '../supabase/functions/_backend/private/invite_existing_user_to_org.ts'

describe('getInviteResendRequiredPermission', () => {
  it.concurrent('requires org.invite_user for non-super-admin invite resends', () => {
    expect(getInviteResendRequiredPermission('org_member', false, true)).toBe('org.invite_user')
  })

  it.concurrent('requires org.update_user_roles for super-admin invite resends', () => {
    expect(getInviteResendRequiredPermission('org_super_admin', true, false)).toBe('org.update_user_roles')
  })

  it.concurrent('allows resend when the caller has the needed permission', () => {
    expect(getInviteResendRequiredPermission('org_member', true, false)).toBeNull()
    expect(getInviteResendRequiredPermission('org_super_admin', true, true)).toBeNull()
  })
})
