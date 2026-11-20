import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectConsoleWebOrigins, DEFAULT_CONSOLE_WEB_ORIGINS, isAllowedConsoleWebOrigin } from '../supabase/functions/_backend/utils/console_web_origins.ts'

const mockedEnv: Record<string, string> = {
  WEBAPP_URL: 'https://console.selfhost.example',
}

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: () => mockedEnv,
  }
})

function createContext() {
  return {} as never
}

describe('console web origins', () => {
  beforeEach(() => {
    mockedEnv.WEBAPP_URL = 'https://console.selfhost.example'
  })
  it('scopes default console origins to the WEBAPP_URL environment', () => {
    mockedEnv.WEBAPP_URL = 'https://console.capgo.app'
    const allowed = collectConsoleWebOrigins(createContext())
    expect(allowed.has('https://console.capgo.app')).toBe(true)
    expect(allowed.has('https://console.capgo.com.cn')).toBe(true)
    expect(allowed.has('https://console.preprod.capgo.app')).toBe(false)
    expect(allowed.has('https://console.development.capgo.app')).toBe(false)
  })

  it('production WEBAPP_URL does not allow Stripe redirects to preprod', () => {
    mockedEnv.WEBAPP_URL = 'https://console.capgo.app'
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.preprod.capgo.app')).toBe(false)
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.development.capgo.app')).toBe(false)
  })

  it('allows Stripe redirects on the China console host', () => {
    mockedEnv.WEBAPP_URL = 'https://console.capgo.app'
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.capgo.com.cn')).toBe(true)
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://evil.example')).toBe(false)
  })

  it('includes WEBAPP_URL for self-hosted console deployments', () => {
    const allowed = collectConsoleWebOrigins(createContext())
    expect(allowed.has('https://console.selfhost.example')).toBe(true)
    expect(allowed.has('https://console.capgo.com.cn')).toBe(false)
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.selfhost.example')).toBe(true)
  })

  it.concurrent('documents all Capgo-hosted console origins', () => {
    for (const origin of DEFAULT_CONSOLE_WEB_ORIGINS)
      expect(typeof origin).toBe('string')
  })

  it('parses comma separated extra console origins with whitespace', () => {
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://extra.console.example', ' https://extra.console.example , https://other.console.example ')).toBe(true)
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://other.console.example', ' https://extra.console.example , https://other.console.example ')).toBe(true)
  })
})