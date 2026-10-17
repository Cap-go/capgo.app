import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('../src/services/capgoApi', () => ({ invokeCapgoApi: invokeMock }))
const { registerAccount } = await import('../src/services/registration')

describe('console registration API client', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates an account without names using the public API', async () => {
    const result = { user: { id: 'fake-user' }, session: { access_token: 'fake-access', refresh_token: 'fake-refresh' } }
    invokeMock.mockResolvedValue({ data: result, error: null })
    expect(await registerAccount('signup@example.com', 'Password123!', 'captcha')).toEqual(result)
    expect(invokeMock).toHaveBeenCalledWith('auth/register', {
      method: 'POST',
      allowAnonymous: true,
      body: { email: 'signup@example.com', password: 'Password123!', captcha_token: 'captcha', opt_for_newsletters: true },
    })
  })

  it('omits a missing CAPTCHA and rejects an incomplete API session', async () => {
    invokeMock.mockResolvedValue({ data: { user: { id: 'fake-user' } }, error: null })
    await expect(registerAccount('signup@example.com', 'Password123!')).rejects.toThrow('incomplete session')
    expect(invokeMock.mock.calls[0][1].body).not.toHaveProperty('captcha_token')
  })

  it('propagates API failures so the form stays available for retry', async () => {
    const error = new Error('API unavailable')
    invokeMock.mockResolvedValue({ data: null, error })
    await expect(registerAccount('signup@example.com', 'Password123!')).rejects.toBe(error)
  })
})
