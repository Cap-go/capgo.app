import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetEnv } = vi.hoisted(() => ({ mockGetEnv: vi.fn() }))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>()
  return { ...actual, getEnv: mockGetEnv }
})

const { chinaApiOriginForRequest, getPublicApiUrl, isChinaApiHostname } = await import('../supabase/functions/_backend/utils/publicApiUrl.ts')
const { manifestUploadPublicUrl } = await import('../supabase/functions/_backend/private/request_manifest_upload.ts')

function fakeContext(url: string) {
  return { req: { url } } as any
}

function useEnv(values: Record<string, string>) {
  mockGetEnv.mockImplementation((_c: unknown, key: string) => values[key] ?? '')
}

describe('public API URL for China requests', () => {
  beforeEach(() => {
    mockGetEnv.mockReset()
    useEnv({})
  })

  it('recognizes only the China API hostname', () => {
    expect(isChinaApiHostname('api.capgo.com.cn')).toBe(true)
    expect(isChinaApiHostname('API.capgo.com.cn.')).toBe(true)
    expect(isChinaApiHostname('api.capgo.app')).toBe(false)
    expect(isChinaApiHostname('evil.capgo.com.cn.attacker.com')).toBe(false)
    expect(isChinaApiHostname('console.capgo.com.cn')).toBe(false)
  })

  it('returns the China origin for a request made on the China API host', () => {
    expect(chinaApiOriginForRequest('https://api.capgo.com.cn/build/request')).toBe('https://api.capgo.com.cn')
    expect(chinaApiOriginForRequest('https://api.capgo.app/build/request')).toBeNull()
    expect(chinaApiOriginForRequest('not a url')).toBeNull()
  })

  it('keeps PUBLIC_URL for global requests and uses the China host for China requests', () => {
    useEnv({ PUBLIC_URL: 'https://uploads.example.com' })
    expect(getPublicApiUrl(fakeContext('https://api.capgo.app/build/request'))).toBe('https://uploads.example.com')
    expect(getPublicApiUrl(fakeContext('https://api.capgo.com.cn/build/request'))).toBe('https://api.capgo.com.cn')
  })

  it('falls back to the default API host when PUBLIC_URL is unset', () => {
    expect(getPublicApiUrl(fakeContext('https://api.capgo.app/build/request'))).toBe('https://api.capgo.app')
  })

  it('uses the China host for manifest uploads started on the China API host', () => {
    useEnv({ FILES_PUBLIC_URL: 'https://files.example.com', PUBLIC_URL: 'https://uploads.example.com' })
    expect(manifestUploadPublicUrl(fakeContext('https://api.capgo.com.cn/private/request_manifest_upload'))).toBe('https://api.capgo.com.cn')
    expect(manifestUploadPublicUrl(fakeContext('https://api.capgo.app/private/request_manifest_upload'))).toBe('https://files.example.com')
  })
})
