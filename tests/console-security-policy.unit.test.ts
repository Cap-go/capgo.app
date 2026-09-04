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

  it.concurrent('allows localhost only in dev mode', () => {
    const devPolicy = buildConsoleContentSecurityPolicy({ dev: true })
    expect(devPolicy).toContain('http://localhost:*')
    expect(devPolicy).not.toContain('upgrade-insecure-requests')
  })

  it.concurrent('does not allow fonts.bunny.net after self-hosting webfonts', () => {
    expect(CONSOLE_CONTENT_SECURITY_POLICY).not.toContain('fonts.bunny.net')
  })
})
