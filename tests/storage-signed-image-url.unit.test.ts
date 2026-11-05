import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const mockCreateSignedUrl = vi.fn()
const mockFrom = vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl }))
const mockGetSession = vi.fn()
const mockInvoke = vi.fn()

vi.mock('../src/services/console.ts', () => ({
  defaultApiHost: 'https://api.example.com',
  useConsole: () => ({
    auth: { getSession: mockGetSession },
    functions: { invoke: mockInvoke },
    storage: {
      from: mockFrom,
    },
  }),
}))

function session(userId = USER_ID) {
  return { data: { session: { user: { id: userId } } }, error: null }
}

function issuedToken(token: string, expiresAt: number) {
  return { data: { data: { token, expiresAt }, error: null }, error: null }
}

describe('resolveImagePath', () => {
  it('extracts the storage path from a console image relay URL', async () => {
    const { resolveImagePath } = await import('../src/services/storage.ts')
    expect(resolveImagePath('https://api.example.com/private/console/images/read?path=org%2Flogo.png&t=t')).toEqual({
      normalized: 'org/logo.png',
      shouldSign: true,
    })
    expect(resolveImagePath('https://api.example.com/private/console/images/read?path=org%2Flogo.png&token=t')).toEqual({
      normalized: 'org/logo.png',
      shouldSign: true,
    })
    expect(resolveImagePath('https://api.example.com/private/console/images/read?path=org%2Flogo%20with%20spaces%25.png&token=t')).toEqual({
      normalized: 'org/logo with spaces%.png',
      shouldSign: true,
    })
  })

  it('hands storage URLs, encoded routes included, to the API whole so it can check their origin', async () => {
    const { resolveImagePath } = await import('../src/services/storage.ts')
    for (const url of [
      'https://db.example.com/storage/v1/object/public/%69mages/org%2Flogo%2520x.png',
      'https://db.example.com/storage/v1/object/public/images/org/logo%20x.png',
    ])
      expect(resolveImagePath(url)).toEqual({ normalized: url, shouldSign: true })
  })

  it('leaves a foreign URL that only looks like the relay untouched', async () => {
    const { resolveImagePath } = await import('../src/services/storage.ts')
    const foreign = 'https://images.example.org/private/console/images/read?path=org%2Flogo.png&token=t'
    expect(resolveImagePath(foreign)).toEqual({ normalized: foreign, shouldSign: false })
  })
})

describe('createSignedImageUrl', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const nowSeconds = Math.floor(now.getTime() / 1000)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    mockGetSession.mockResolvedValue(session())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds relay URLs from one image token instead of signing each image', async () => {
    mockInvoke.mockResolvedValue(issuedToken('tok-1', nowSeconds + 12 * 3600))

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    const [logo, icon] = await Promise.all([
      createSignedImageUrl('org/org-1/logo/logo.png'),
      createSignedImageUrl('/images/org/org-1/com.app/icon'),
    ])

    expect(logo).toBe('https://api.example.com/private/console/images/read?path=org%2Forg-1%2Flogo%2Flogo.png&t=tok-1')
    expect(icon).toBe('https://api.example.com/private/console/images/read?path=org%2Forg-1%2Fcom.app%2Ficon&t=tok-1')
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(mockInvoke).toHaveBeenCalledWith('private/console/images/token', { body: {} })
    expect(mockCreateSignedUrl).not.toHaveBeenCalled()

    // A relay URL already on screen resolves back to the same URL.
    await expect(createSignedImageUrl(logo)).resolves.toBe(logo)
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('renews the token before it expires and on forceRefresh', async () => {
    mockInvoke
      .mockResolvedValueOnce(issuedToken('tok-1', nowSeconds + 2 * 3600))
      .mockResolvedValueOnce(issuedToken('tok-2', nowSeconds + 14 * 3600))
      .mockResolvedValueOnce(issuedToken('tok-3', nowSeconds + 14 * 3600))

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    expect(await createSignedImageUrl('u/a.png')).toContain('t=tok-1')
    expect(await createSignedImageUrl('u/a.png')).toContain('t=tok-1')

    vi.advanceTimersByTime(60 * 60 * 1000 + 1)
    expect(await createSignedImageUrl('u/a.png')).toContain('t=tok-2')
    expect(await createSignedImageUrl('u/a.png', { forceRefresh: true })).toContain('t=tok-3')
    expect(mockInvoke).toHaveBeenCalledTimes(3)
  })

  it('never reuses another user token', async () => {
    mockInvoke
      .mockResolvedValueOnce(issuedToken('tok-user-1', nowSeconds + 12 * 3600))
      .mockResolvedValueOnce(issuedToken('tok-user-2', nowSeconds + 12 * 3600))

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    expect(await createSignedImageUrl('u/a.png')).toContain('t=tok-user-1')
    mockGetSession.mockResolvedValue(session('22222222-2222-4222-8222-222222222222'))
    expect(await createSignedImageUrl('u/a.png')).toContain('t=tok-user-2')
  })

  it('returns no URL when signed out or the token request fails', async () => {
    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    mockGetSession.mockResolvedValueOnce({ data: { session: null }, error: null })
    await expect(createSignedImageUrl('u/a.png')).resolves.toBe('')

    mockInvoke.mockResolvedValueOnce({ data: null, error: new Error('down') })
    await expect(createSignedImageUrl('u/a.png')).resolves.toBe('')
  })

  it('still sends legacy storage URLs to the API to be re-signed', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: 'https://api.example.com/private/console/images/read?path=org%2Forg-1%2Flogo%2Flogo.png&t=fresh' },
      error: null,
    })

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    const legacy = 'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/logo.png?token=stale'
    const result = await createSignedImageUrl(legacy)

    expect(result).toBe('https://api.example.com/private/console/images/read?path=org%2Forg-1%2Flogo%2Flogo.png&t=fresh')
    expect(mockFrom).toHaveBeenCalledWith('images')
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(legacy, 60 * 60 * 24 * 7)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
