import { describe, expect, it } from 'vitest'
import { shouldAttemptExistingUserInviteNotification } from '../src/utils/invites'

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
