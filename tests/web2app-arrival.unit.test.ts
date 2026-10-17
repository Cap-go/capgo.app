import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRememberedWeb2AppArrival,
  parseWeb2AppArrival,
  readRememberedWeb2AppArrival,
  rememberWeb2AppArrival,
  web2AppArrivalQuery,
} from '../src/utils/web2appArrival'

const registerSource = readFileSync(new URL('../src/pages/register.vue', import.meta.url), 'utf8')

function stubLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  })
  return store
}

describe('web2App arrival query params', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefills a valid website and normalizes it', () => {
    expect(parseWeb2AppArrival({ ref: 'webnativeapp', website: 'app.example.com' })).toEqual({ websiteUrl: 'https://app.example.com/' })
    expect(parseWeb2AppArrival({ website: 'https://app.example.com/index.html' })).toEqual({ websiteUrl: 'https://app.example.com/' })
    expect(parseWeb2AppArrival({ website: ['https://shop.example.com', null] })).toEqual({ websiteUrl: 'https://shop.example.com/' })
  })

  it('preselects publish for the legacy ref without a website', () => {
    expect(parseWeb2AppArrival({ ref: 'webnativeapp' })).toEqual({ websiteUrl: null })
    expect(parseWeb2AppArrival({ ref: 'WebNativeApp' })).toEqual({ websiteUrl: null })
  })

  it('rejects websites that normalizeWebsiteLiveUrl rejects', () => {
    expect(parseWeb2AppArrival({ ref: 'webnativeapp', website: 'http://app.example.com' })).toEqual({ websiteUrl: null })
    expect(parseWeb2AppArrival({ ref: 'webnativeapp', website: 'https://app.example.com/sub/path' })).toEqual({ websiteUrl: null })
    expect(parseWeb2AppArrival({ website: 'localhost' })).toBeNull()
    expect(parseWeb2AppArrival({ website: 'javascript:alert(1)' })).toBeNull()
  })

  it('ignores unrelated queries', () => {
    expect(parseWeb2AppArrival({})).toBeNull()
    expect(parseWeb2AppArrival({ ref: 'producthunt' })).toBeNull()
    expect(parseWeb2AppArrival({ to: '/dashboard' })).toBeNull()
  })

  it('reads params carried through the auth guard `to` redirect', () => {
    expect(parseWeb2AppArrival({ to: '/dashboard?ref=webnativeapp&website=app.example.com' })).toEqual({ websiteUrl: 'https://app.example.com/' })
    expect(parseWeb2AppArrival({ to: '/dashboard?ref=webnativeapp' })).toEqual({ websiteUrl: null })
    expect(parseWeb2AppArrival({ to: '//evil.example.com/?ref=webnativeapp' })).toBeNull()
    expect(parseWeb2AppArrival({ to: 'https://evil.example.com/?ref=webnativeapp' })).toBeNull()
  })

  it('forwards only the arrival params', () => {
    expect(web2AppArrivalQuery({ ref: 'webnativeapp', utm_source: 'x', website: 'app.example.com' })).toEqual({ ref: 'webnativeapp', website: 'app.example.com' })
    expect(web2AppArrivalQuery({})).toEqual({})
  })

  it('remembers an arrival across email confirmation for a week', () => {
    const store = stubLocalStorage()
    const savedAt = Date.UTC(2026, 9, 1)
    rememberWeb2AppArrival({ websiteUrl: 'https://app.example.com/' }, savedAt)
    expect(store.size).toBe(1)
    expect(readRememberedWeb2AppArrival(savedAt + 1000)).toEqual({ websiteUrl: 'https://app.example.com/' })
    expect(readRememberedWeb2AppArrival(savedAt + 8 * 24 * 60 * 60 * 1000)).toBeNull()
    clearRememberedWeb2AppArrival()
    expect(readRememberedWeb2AppArrival(savedAt + 1000)).toBeNull()
  })

  it('ignores corrupted remembered arrivals and works without storage', () => {
    const store = stubLocalStorage()
    store.set('capgo:web2app-arrival', '{not json')
    expect(readRememberedWeb2AppArrival()).toBeNull()
    store.set('capgo:web2app-arrival', JSON.stringify({ savedAt: Date.now(), websiteUrl: 'http://insecure.example.com' }))
    expect(readRememberedWeb2AppArrival()).toEqual({ websiteUrl: null })
    vi.unstubAllGlobals()
    expect(readRememberedWeb2AppArrival()).toBeNull()
    expect(() => rememberWeb2AppArrival({ websiteUrl: null })).not.toThrow()
  })

  it('carries arrival params from /register into onboarding', () => {
    expect(registerSource).toContain('const web2AppArrival = parseWeb2AppArrival(route.query)')
    expect(registerSource).toContain('rememberWeb2AppArrival(web2AppArrival)')
    expect(registerSource).toContain(`router.push({ path: '/dashboard', query: web2AppQuery })`)
    expect(registerSource).toMatch(/window\.location\.href = `https:\/\/capgo\.app\/register\/\$\{window\.location\.search\}`/)
  })
})
