import { describe, expect, it } from 'vitest'
import { chinaApiOriginForRequest, getPublicApiUrl, isChinaApiHostname } from '../supabase/functions/_backend/utils/publicApiUrl.ts'

function fakeContext(url: string, env: Record<string, string> = {}) {
  return { req: { url }, env } as any
}

describe('public API URL for China requests', () => {
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
    const env = { PUBLIC_URL: 'https://api.capgo.app' }
    expect(getPublicApiUrl(fakeContext('https://api.capgo.app/build/request', env))).toBe('https://api.capgo.app')
    expect(getPublicApiUrl(fakeContext('https://api.capgo.com.cn/build/request', env))).toBe('https://api.capgo.com.cn')
  })

  it('falls back to the default API host when PUBLIC_URL is unset', () => {
    expect(getPublicApiUrl(fakeContext('https://api.capgo.app/build/request'))).toBe('https://api.capgo.app')
  })
})
