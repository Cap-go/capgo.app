import { describe, expect, it, vi } from 'vitest'
import { collectConsoleWebOrigins, DEFAULT_CONSOLE_WEB_ORIGINS, isAllowedConsoleWebOrigin } from '../supabase/functions/_backend/utils/console_web_origins.ts'

const mockedEnv: Record<string, string> = {
  WEBAPP_URL: 'https://console.capgo.app',
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
  it.concurrent('includes the China console origin', () => {
    const allowed = collectConsoleWebOrigins(createContext())
    expect(allowed.has('https://console.capgo.com.cn')).toBe(true)
    for (const origin of DEFAULT_CONSOLE_WEB_ORIGINS)
      expect(allowed.has(origin)).toBe(true)
  })

  it.concurrent('allows Stripe redirects on the China console host', () => {
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.capgo.com.cn')).toBe(true)
    expect(isAllowedConsoleWebOrigin(createContext(), 'https://evil.example')).toBe(false)
  })

  it.concurrent('includes WEBAPP_URL alongside default console origins', () => {
    mockedEnv.WEBAPP_URL = 'https://console.selfhost.example'
    try {
      const allowed = collectConsoleWebOrigins(createContext())
      expect(allowed.has('https://console.selfhost.example')).toBe(true)
      expect(isAllowedConsoleWebOrigin(createContext(), 'https://console.selfhost.example')).toBe(true)
    }
    finally {
      mockedEnv.WEBAPP_URL = 'https://console.capgo.app'
    }
  })
})