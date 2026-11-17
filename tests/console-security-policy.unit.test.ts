import { describe, expect, it, vi } from 'vitest'
import configs from '../configs.json'
import { buildConsoleContentSecurityPolicy, CONSOLE_CONTENT_SECURITY_POLICY, withConsoleContentSecurityPolicy } from '../scripts/console-security-policy.ts'

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

  it.concurrent('includes the production API connect source only, never a database host', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('sb.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('supabase.co')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toContain('https://api.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('https://api.preprod.capgo.app')
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('https://api.dev.capgo.app')
  })

  it('includes self-hosted deploy-time connect overrides from env', () => {
    const previousApiDomain = process.env.API_DOMAIN
    process.env.API_DOMAIN = 'api.selfhost.example'
    try {
      expect(buildConsoleContentSecurityPolicy()).toContain('https://api.selfhost.example')
    }
    finally {
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

  it.concurrent('allows the assistant ChatGPT sign-in and OpenAI API hosts in connect-src', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/auth\.openai\.com/)
    expect(CONSOLE_CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/api\.openai\.com/)
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

  it.each([
    ['prod', 'https://plugin.eu.capgo.app'],
    ['preprod', 'https://plugin.preprod.capgo.app'],
    ['development', 'https://plugin.dev.capgo.app'],
    ['local', 'http://localhost:8788'],
  ] as const)('allows only the configured %s policy gateway origin', (environment, origin) => {
    vi.stubEnv('PLUGIN_REGION_TARGETS', configs.plugin_region_targets[environment])
    vi.stubEnv('API_DOMAIN', configs.api_domain[environment])
    try {
      const connect = buildConsoleContentSecurityPolicy().split('; ').find(directive => directive.startsWith('connect-src '))
      expect(connect).toContain(origin)
      const apiProtocol = environment === 'local' ? 'http:' : 'https:'
      expect(connect).toContain(new URL(`${apiProtocol}//${configs.api_domain[environment]}`).origin)
      if (environment !== 'prod')
        expect(connect).not.toContain('https://api.capgo.app')
      expect(connect).not.toContain('https://*.capgo.app')
      const emitted = withConsoleContentSecurityPolicy('/*\n  Content-Security-Policy: stale-policy\n  X-Content-Type-Options: nosniff\n')
      expect(emitted).toContain(`Content-Security-Policy: ${buildConsoleContentSecurityPolicy()}`)
      expect(emitted).toContain('X-Content-Type-Options: nosniff')
      for (const other of ['https://plugin.eu.capgo.app', 'https://plugin.preprod.capgo.app', 'https://plugin.dev.capgo.app', 'http://localhost:8788']) {
        if (other !== origin)
          expect(connect).not.toContain(other)
      }
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('allows an explicitly overridden policy gateway without retaining the default origin', () => {
    vi.stubEnv('VITE_SERVING_POLICY_URL', 'https://gateway.example.com/plugins/serving_policy/')
    try {
      const connect = buildConsoleContentSecurityPolicy().split('; ').find(directive => directive.startsWith('connect-src '))
      expect(connect).toContain('https://gateway.example.com')
      expect(connect).not.toContain('https://plugin.eu.capgo.app')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects a missing CSP declaration instead of producing incomplete deployment headers', () => {
    expect(() => withConsoleContentSecurityPolicy('/*\n  X-Content-Type-Options: nosniff\n')).toThrow()
  })
})
