import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateSignedUrl = vi.fn()
const mockFrom = vi.fn(() => ({ createSignedUrl: mockCreateSignedUrl }))

vi.mock('../src/services/console.ts', () => ({
  useConsole: () => ({
    storage: {
      from: mockFrom,
    },
  }),
}))

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

  it('extracts the storage path from signed image URLs before refreshing them', async () => {
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
    expect(mockCreateSignedUrl).toHaveBeenCalledWith('org/org-1/logo/logo.png', 60 * 60 * 24 * 7)
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
