import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
  getEnv: vi.fn(),
  supabaseAdmin: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mocks.getEnv,
}))

const {
  assertAllowedImagePath,
  createSignedImageUrl,
  getStorageAllowedOrigins,
  isAllowedImagePath,
  isLegacyBareImageFilename,
  isOwnershipBearingImagePath,
  isSupabaseStorageImageUrl,
  normalizeImagePath,
  resolveWritableImageValue,
} = await import('../supabase/functions/_backend/utils/storage.ts')

describe('image path ownership for signed URLs', () => {
  beforeEach(() => {
    mocks.createSignedUrl.mockReset()
    mocks.supabaseAdmin.mockReset()
    mocks.getEnv.mockReset()
    mocks.getEnv.mockImplementation((_: unknown, key: string) => {
      if (key === 'SUPABASE_URL')
        return 'https://example.supabase.co'
      if (key === 'SUPABASE_REPLICATE_URL')
        return 'https://replica.example.supabase.co'
      return ''
    })
    mocks.supabaseAdmin.mockReturnValue({
      storage: {
        from: () => ({
          createSignedUrl: mocks.createSignedUrl,
        }),
      },
    })
  })

  it('accepts org and user owned prefixes and rejects foreign or traversal paths', () => {
    expect(isAllowedImagePath('org/org-1/logo/a.png', { orgId: 'org-1' })).toBe(true)
    expect(isAllowedImagePath('org/org-1/com.app/icon', { orgId: 'org-1', appId: 'com.app' })).toBe(true)
    expect(isAllowedImagePath('11111111-1111-1111-1111-111111111111/avatar.png', { userId: '11111111-1111-1111-1111-111111111111' })).toBe(true)
    expect(isAllowedImagePath('org/org-2/logo/a.png', { orgId: 'org-1' })).toBe(false)
    expect(isAllowedImagePath('org/org-1/../org-2/secret.png', { orgId: 'org-1' })).toBe(false)
    expect(assertAllowedImagePath('org/org-2/logo/a.png', { orgId: 'org-1' })).toBeNull()
    expect(assertAllowedImagePath('private/secret.png', { orgId: 'org-1' })).toBeNull()
    expect(assertAllowedImagePath('test-icon', { orgId: 'org-1' })).toBe('test-icon')
    expect(isLegacyBareImageFilename('test-icon')).toBe(true)
    expect(isOwnershipBearingImagePath('test-icon')).toBe(false)
    expect(isOwnershipBearingImagePath('private/secret.png')).toBe(true)
    expect(isOwnershipBearingImagePath('org/org-1/logo/a.png')).toBe(true)
  })

  it('collects primary and replica storage origins', () => {
    const context = {} as Parameters<typeof getStorageAllowedOrigins>[0]
    expect(getStorageAllowedOrigins(context)).toEqual([
      'https://example.supabase.co',
      'https://replica.example.supabase.co',
    ])
  })

  it('refuses to mint admin signed URLs for foreign org paths', async () => {
    const context = {} as Parameters<typeof createSignedImageUrl>[0]
    await expect(createSignedImageUrl(context, 'org/victim-org/private.png', { orgId: 'attacker-org' })).resolves.toBeNull()
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('refuses foldered paths without a matching scope', async () => {
    const context = {} as Parameters<typeof createSignedImageUrl>[0]
    await expect(createSignedImageUrl(context, 'private/secret.png')).resolves.toBeNull()
    await expect(createSignedImageUrl(context, 'org/org-1/logo/a.png')).resolves.toBeNull()
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('signs allowed org paths with the admin storage client', async () => {
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example/org-1.png' },
      error: null,
    })
    const context = {} as Parameters<typeof createSignedImageUrl>[0]
    await expect(createSignedImageUrl(context, 'org/org-1/logo/a.png', { orgId: 'org-1' }))
      .resolves
      .toBe('https://signed.example/org-1.png')
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('org/org-1/logo/a.png', expect.any(Number))
  })

  it('still signs legacy bare filenames', async () => {
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example/legacy.png' },
      error: null,
    })
    const context = {} as Parameters<typeof createSignedImageUrl>[0]
    await expect(createSignedImageUrl(context, 'test-icon'))
      .resolves
      .toBe('https://signed.example/legacy.png')
  })

  it('keeps external non-storage URLs unsigned', async () => {
    const context = {} as Parameters<typeof createSignedImageUrl>[0]
    await expect(createSignedImageUrl(context, 'https://cdn.example/logo.png'))
      .resolves
      .toBe('https://cdn.example/logo.png')
    expect(mocks.createSignedUrl).not.toHaveBeenCalled()
  })

  it('ignores storage-shaped paths on foreign hosts', () => {
    expect(normalizeImagePath(
      'https://evil.example/storage/v1/object/sign/images/org/org-1/logo/a.png?token=x',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBeNull()
    expect(normalizeImagePath(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/a.png?token=x',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBe('org/org-1/logo/a.png')
    expect(normalizeImagePath(
      'https://replica.example.supabase.co/storage/v1/object/public/images/org/org-1/logo/a.png',
      { allowedOrigins: ['https://example.supabase.co', 'https://replica.example.supabase.co'] },
    )).toBe('org/org-1/logo/a.png')
  })

  it('does not extract storage paths without an allowed origin list', () => {
    expect(normalizeImagePath(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/a.png?token=x',
    )).toBeNull()
    expect(normalizeImagePath(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/a.png?token=x',
      { allowedOrigins: [] },
    )).toBeNull()
  })

  it('rejects unverified storage-shaped URLs on write while keeping true CDN URLs', () => {
    expect(isSupabaseStorageImageUrl(
      'https://evil.example/storage/v1/object/sign/images/org/org-1/logo/a.png',
    )).toBe(true)
    expect(isSupabaseStorageImageUrl('https://cdn.example/logo.png')).toBe(false)
    expect(resolveWritableImageValue(
      'https://cdn.example/logo.png',
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBe('https://cdn.example/logo.png')
    expect(resolveWritableImageValue(
      'https://evil.example/storage/v1/object/sign/images/org/org-1/logo/a.png',
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBeNull()
    expect(resolveWritableImageValue(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/logo/a.png',
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBe('org/org-1/logo/a.png')
    expect(resolveWritableImageValue(
      'org/org-1/logo/a.png',
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBe('org/org-1/logo/a.png')
  })

  it('detects percent-encoded storage routes as storage-shaped URLs', () => {
    const encodedEvil = 'https://evil.example/%73torage/v1/object/sign/images/org/org-1/logo/a.png'
    expect(isSupabaseStorageImageUrl(encodedEvil)).toBe(true)
    expect(resolveWritableImageValue(encodedEvil, { orgId: 'org-1' }, ['https://example.supabase.co']))
      .toBeNull()
    expect(normalizeImagePath(
      'https://example.supabase.co/%73torage/v1/object/sign/images/org/org-1/logo/a.png',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBe('org/org-1/logo/a.png')
  })

  it('decodes object keys only once', () => {
    expect(normalizeImagePath(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/file%20name.png',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBe('org/org-1/file name.png')
    // Encoded route + encoded key: decode route for match, key once.
    expect(normalizeImagePath(
      'https://example.supabase.co/%73torage/v1/object/sign/images/org/org-1/file%20name.png',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBe('org/org-1/file name.png')
  })

  it('rejects malformed percent escapes in storage object keys', () => {
    expect(normalizeImagePath(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/file%.png',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBeNull()
    expect(resolveWritableImageValue(
      'https://example.supabase.co/storage/v1/object/sign/images/org/org-1/file%.png',
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBeNull()
  })

  it('rejects encoded storage routes with malformed keys instead of treating them as CDN URLs', () => {
    const encodedMalformed = 'https://evil.example/%73torage/v1/object/sign/images/org/org-1/file%.png'
    expect(isSupabaseStorageImageUrl(encodedMalformed)).toBe(true)
    expect(resolveWritableImageValue(
      encodedMalformed,
      { orgId: 'org-1' },
      ['https://example.supabase.co'],
    )).toBeNull()
    expect(normalizeImagePath(
      'https://example.supabase.co/%73torage/v1/object/sign/images/org/org-1/file%.png',
      { allowedOrigins: ['https://example.supabase.co'] },
    )).toBeNull()
  })
})
