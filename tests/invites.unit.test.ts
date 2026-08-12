import { describe, expect, it, vi } from 'vitest'
import { completeInviteSessionHandoff, shouldAttemptExistingUserInviteNotification, takeInviteSessionHandoff } from '../src/utils/invites'

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

  function createStorage(initial: Record<string, string> = {}) {
    const store = { ...initial }
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      store,
    }
  }

  it.concurrent('stashes tokens then navigates to login without URL tokens', async () => {
    const storage = createStorage()
    const goToLogin = vi.fn(async () => {})

    await completeInviteSessionHandoff(goToLogin, tokens, storage)

    expect(goToLogin).toHaveBeenCalledTimes(1)
    expect(takeInviteSessionHandoff(storage)).toEqual(tokens)
    expect(takeInviteSessionHandoff(storage)).toBeNull()
  })

  it.concurrent('still navigates when stash storage throws', async () => {
    const goToLogin = vi.fn(async () => {})
    const storage = {
      setItem: () => {
        throw new Error('quota')
      },
    }

    await completeInviteSessionHandoff(goToLogin, tokens, storage)
    expect(goToLogin).toHaveBeenCalledTimes(1)
  })

  it.concurrent('ignores malformed stashed payloads', () => {
    const storage = createStorage({ 'capgo-invite-session-handoff': '{not-json' })
    expect(takeInviteSessionHandoff(storage)).toBeNull()
  })
})
