import { describe, expect, it, vi } from 'vitest'
import {
  getAllowedConfirmationHosts,
  isAllowedConfirmationUrl,
  validateRedirectPath,
} from '../src/utils/safeRedirect.ts'

describe('validateRedirectPath', () => {
  it.concurrent('allows same-origin relative paths', () => {
    expect(validateRedirectPath('/settings/account')).toBe('/settings/account')
    expect(validateRedirectPath('/app/com.demo.app/bundles')).toBe('/app/com.demo.app/bundles')
  })

  it.concurrent('rejects external and protocol-relative targets', () => {
    expect(validateRedirectPath('https://evil.example/phish')).toBe('/dashboard')
    expect(validateRedirectPath('//evil.example/phish')).toBe('/dashboard')
    expect(validateRedirectPath('javascript:alert(1)')).toBe('/dashboard')
  })

  it.concurrent('uses a custom fallback', () => {
    expect(validateRedirectPath('', '/login')).toBe('/login')
    expect(validateRedirectPath(null, '/login')).toBe('/login')
  })

  it.concurrent('blocks configured path prefixes', () => {
    expect(validateRedirectPath('/onboarding/app', '/dashboard', { blockedPrefixes: ['/onboarding'] }))
      .toBe('/dashboard')
    expect(validateRedirectPath('/settings/account', '/dashboard', { blockedPrefixes: ['/onboarding'] }))
      .toBe('/settings/account')
  })
})

describe('isAllowedConfirmationUrl', () => {
  it.concurrent('allows configured https hosts only', () => {
    expect(isAllowedConfirmationUrl('https://console.capgo.app/confirm', {
      allowedHosts: ['console.capgo.app', 'sb.capgo.app'],
    })).toBe(true)
    expect(isAllowedConfirmationUrl('https://evil.example/confirm', {
      allowedHosts: ['console.capgo.app'],
    })).toBe(false)
    expect(isAllowedConfirmationUrl('http://console.capgo.app/confirm', {
      allowedHosts: ['console.capgo.app'],
    })).toBe(false)
  })

  it.concurrent('allows localhost in dev mode', () => {
    expect(isAllowedConfirmationUrl('http://localhost:5173/confirm', {
      allowedHosts: ['console.capgo.app'],
      allowLocalDev: true,
    })).toBe(true)
  })
})

describe('getAllowedConfirmationHosts', () => {
  it.concurrent('parses configured app and supabase hosts', () => {
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.app')
    vi.stubEnv('VITE_SUPABASE_URL', 'https://sb.capgo.app')
    try {
      const hosts = getAllowedConfirmationHosts()
      expect(hosts).toEqual(['console.capgo.app', 'sb.capgo.app'])
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})
