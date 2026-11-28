import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeCapgoApi = vi.fn()
const referral = vi.fn()

vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi }))
vi.mock('~/services/attributionCookies', () => ({ getAffonsoReferral: referral }))

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  })
  invokeCapgoApi.mockReset()
  referral.mockReset()
  referral.mockResolvedValue('clk_1')
})

describe('sendAffonsoSignup', () => {
  it('sends the click id once a signup is tracked', async () => {
    invokeCapgoApi.mockResolvedValue({ data: { status: 'tracked' }, error: null })
    const { sendAffonsoSignup } = await import('../src/services/affonso')

    await sendAffonsoSignup('user-1')
    await sendAffonsoSignup('user-1')

    expect(invokeCapgoApi).toHaveBeenCalledTimes(1)
    expect(invokeCapgoApi).toHaveBeenCalledWith('private/affonso_signup', { body: JSON.stringify({ clickId: 'clk_1' }) })
  })

  it('retries later when the API key or profile was missing, or the call failed', async () => {
    const { sendAffonsoSignup } = await import('../src/services/affonso')
    for (const response of [
      { data: { status: 'no_api_key' }, error: null },
      { data: { status: 'no_user' }, error: null },
      { data: null, error: new Error('offline') },
    ]) {
      invokeCapgoApi.mockResolvedValueOnce(response)
      await sendAffonsoSignup('user-1')
    }
    expect(invokeCapgoApi).toHaveBeenCalledTimes(3)
    expect(store.size).toBe(0)
  })

  it('stops after an old account is declined', async () => {
    invokeCapgoApi.mockResolvedValue({ data: { status: 'account_too_old' }, error: null })
    const { sendAffonsoSignup } = await import('../src/services/affonso')

    await sendAffonsoSignup('user-1')
    await sendAffonsoSignup('user-1')

    expect(invokeCapgoApi).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a user or affiliate cookie', async () => {
    const { sendAffonsoSignup } = await import('../src/services/affonso')
    await sendAffonsoSignup(undefined)
    referral.mockResolvedValue('')
    await sendAffonsoSignup('user-1')
    expect(invokeCapgoApi).not.toHaveBeenCalled()
  })
})
