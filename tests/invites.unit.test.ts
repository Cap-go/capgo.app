import { describe, expect, it, vi } from 'vitest'
import { completeInviteSessionHandoff, shouldAttemptExistingUserInviteNotification } from '../src/utils/invites'

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

describe('completeInviteSessionHandoff', () => {
  const tokens = { access_token: 'access', refresh_token: 'refresh' }

  it.concurrent('sets the session then navigates to login without URL tokens', async () => {
    const setSession = vi.fn(async () => ({ error: null }))
    const goToLogin = vi.fn(async () => {})

    await completeInviteSessionHandoff(setSession, goToLogin, tokens)

    expect(setSession).toHaveBeenCalledWith(tokens)
    expect(goToLogin).toHaveBeenCalledTimes(1)
  })

  it.concurrent('does not navigate when setSession fails', async () => {
    const setSession = vi.fn(async () => ({ error: { message: 'session_failed' } }))
    const goToLogin = vi.fn(async () => {})

    await expect(completeInviteSessionHandoff(setSession, goToLogin, tokens))
      .rejects
      .toThrow('session_failed')
    expect(goToLogin).not.toHaveBeenCalled()
  })
})
