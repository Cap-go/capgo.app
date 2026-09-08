import { describe, expect, it } from 'vitest'
import { buildConsoleContentSecurityPolicy, CONSOLE_CONTENT_SECURITY_POLICY } from '../scripts/console-security-policy.ts'

describe('console content security policy', () => {
  it.concurrent('exports a production policy without localhost connect sources', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('default-src \'self\'')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://challenges.cloudflare.com')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://psthg.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('http://localhost')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('upgrade-insecure-requests')
  })

  it.concurrent('does not allow unsafe-inline scripts in production', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('script-src \'self\' https://challenges.cloudflare.com')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })

  it.concurrent('includes production API and Supabase connect sources only', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://sb.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://api.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('https://api.preprod.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('https://api.dev.capgo.app')
  })

  it('includes self-hosted deploy-time connect overrides from env', () => {
    const previousSupaUrl = process.env.SUPA_URL
    const previousApiDomain = process.env.API_DOMAIN
    process.env.SUPA_URL = 'https://selfhost.supabase.co'
    process.env.API_DOMAIN = 'api.selfhost.example'
    try {
      const policy = buildConsoleContentSecurityPolicy()
      expect(policy).toContain('https://selfhost.supabase.co')
      expect(policy).toContain('wss://selfhost.supabase.co')
      expect(policy).toContain('https://api.selfhost.example')
    }
    finally {
      if (previousSupaUrl === undefined)
        delete process.env.SUPA_URL
      else
        process.env.SUPA_URL = previousSupaUrl
      if (previousApiDomain === undefined)
        delete process.env.API_DOMAIN
      else
        process.env.API_DOMAIN = previousApiDomain
    }
  })

  it.concurrent('allows bundle preview fetch hosts in connect-src', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://*.preview.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://*.preview.preprod.capgo.app')
  })

  it.concurrent('allows localhost only in dev mode', () => {
    const devPolicy = buildConsoleContentSecurityPolicy({ dev: true })
    expect(devPolicy).toContain('http://localhost:*')
    expect(devPolicy).toContain('https://api.preprod.capgo.app')
    expect(devPolicy).not.toContain('upgrade-insecure-requests')
  })

  it.concurrent('does not allow fonts.bunny.net after self-hosting webfonts', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('fonts.bunny.net')
  })
})
