import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateSignedUrl = vi.fn()
const mockFrom = vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl }))

vi.mock('../src/services/console.ts', () => ({
  defaultApiHost: 'https://api.example.com',
  useConsole: () => ({
    storage: {
      from: mockFrom,
    },
  }),
}))

describe('resolveImagePath', () => {
  it('extracts the storage path from a console image relay URL', async () => {
    const { resolveImagePath } = await import('../src/services/storage.ts')
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
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends signed storage URLs to the API to be re-signed', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({
      data: {
        signedUrl: 'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/logo.png?token=fresh',
      },
      error: null,
    })

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    const result = await createSignedImageUrl('https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/logo.png?token=stale')

    expect(result).toBe('https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/logo.png?token=fresh')
    expect(mockFrom).toHaveBeenCalledWith('images')
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/logo.png?token=stale', 60 * 60 * 24 * 7)
  })

  it('bypasses the cached signed URL when forceRefresh is requested', async () => {
    mockCreateSignedUrl
      .mockResolvedValueOnce({
        data: {
          signedUrl: 'https://example.supabase.co/storage/v1/object/sign/images/org/org-2/logo/logo.png?token=initial',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          signedUrl: 'https://example.supabase.co/storage/v1/object/sign/images/org/org-2/logo/logo.png?token=refreshed',
        },
        error: null,
      })

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    const firstUrl = await createSignedImageUrl('org/org-2/logo/logo.png')
    const cachedUrl = await createSignedImageUrl('org/org-2/logo/logo.png')
    const refreshedUrl = await createSignedImageUrl(firstUrl, { forceRefresh: true })

    expect(firstUrl).toBe('https://example.supabase.co/storage/v1/object/sign/images/org/org-2/logo/logo.png?token=initial')
    expect(cachedUrl).toBe(firstUrl)
    expect(refreshedUrl).toBe('https://example.supabase.co/storage/v1/object/sign/images/org/org-2/logo/logo.png?token=refreshed')
    expect(mockCreateSignedUrl).toHaveBeenCalledTimes(2)
  })

  it('re-signs the image after the cache max age elapses', async () => {
    mockCreateSignedUrl
      .mockResolvedValueOnce({
        data: {
          signedUrl: 'https://example.supabase.co/storage/v1/object/sign/images/org/org-3/logo/logo.png?token=initial',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          signedUrl: 'https://example.supabase.co/storage/v1/object/sign/images/org/org-3/logo/logo.png?token=renewed',
        },
        error: null,
      })

    const { createSignedImageUrl } = await import('../src/services/storage.ts')
    const firstUrl = await createSignedImageUrl('org/org-3/logo/logo.png')

    vi.advanceTimersByTime(15 * 60 * 1000 + 1)

    const renewedUrl = await createSignedImageUrl('org/org-3/logo/logo.png')

    expect(firstUrl).toBe('https://example.supabase.co/storage/v1/object/sign/images/org/org-3/logo/logo.png?token=initial')
    expect(renewedUrl).toBe('https://example.supabase.co/storage/v1/object/sign/images/org/org-3/logo/logo.png?token=renewed')
    expect(mockCreateSignedUrl).toHaveBeenCalledTimes(2)
  })
})
