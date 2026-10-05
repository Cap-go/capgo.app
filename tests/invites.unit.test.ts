import { FunctionsHttpError } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { resolveInviteNewUserErrorMessage, shouldAttemptExistingUserInviteNotification } from '../src/utils/invites'

describe('shouldAttemptExistingUserInviteNotification', () => {
  it.concurrent('returns true for new invites and pending invite resends', () => {
    expect(shouldAttemptExistingUserInviteNotification('OK')).toBe(true)
    expect(shouldAttemptExistingUserInviteNotification('ALREADY_INVITED', true)).toBe(true)
  })

  it.concurrent('returns false for outputs that should not send email', () => {
    expect(shouldAttemptExistingUserInviteNotification('NO_EMAIL')).toBe(false)
    expect(shouldAttemptExistingUserInviteNotification('CAN_NOT_INVITE_OWNER')).toBe(false)
    expect(shouldAttemptExistingUserInviteNotification('ALREADY_INVITED')).toBe(false)
  })
})

describe('resolveInviteNewUserErrorMessage', () => {
  it('maps rejected domain names to a clear message', async () => {
    const error = new FunctionsHttpError(new Response(JSON.stringify({
      error: 'invite_name_domain_not_allowed',
    }), {
      headers: { 'content-type': 'application/json' },
      status: 400,
    }))

    const message = await resolveInviteNewUserErrorMessage(error, key => key)
    expect(message).toBe('invite-name-domain-not-allowed')
  })
})
