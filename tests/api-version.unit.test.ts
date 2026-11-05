import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'

import {
  CAPGO_API_DEFAULT_VERSION,
  CAPGO_API_VERSION_HEADER,
  resolveCapgoApiVersion,
} from '../supabase/functions/_backend/utils/api_version.ts'

function createContext(headers: Record<string, string | undefined> = {}) {
  const headerMap = new Map<string, string | undefined>(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )

  return {
    req: {
      header: (name: string) => headerMap.get(name.toLowerCase()),
    },
    get: (key: string) => (key === 'requestId' ? 'test-request' : undefined),
  } as any
}

describe('resolveCapgoApiVersion', () => {
  it('uses the default version when header is missing', () => {
    const ctx = createContext()
    const version = resolveCapgoApiVersion(ctx)

    expect(version.isDefault).toBe(true)
    expect(version.raw).toBe(CAPGO_API_DEFAULT_VERSION)
    expect(version.normalized).toBe('2025.10.1')
    expect(version.equals('2025-10-01')).toBe(true)
  })

  it('parses semantic versions from the header', () => {
    const ctx = createContext({ [CAPGO_API_VERSION_HEADER]: 'v2.1' })
    const version = resolveCapgoApiVersion(ctx)

    expect(version.isDefault).toBe(false)
    expect(version.major).toBe(2)
    expect(version.minor).toBe(1)
    expect(version.patch).toBe(0)
    expect(version.normalized).toBe('2.1.0')
    expect(version.atLeast('2.0')).toBe(true)
    expect(version.before('3')).toBe(true)
  })

  it('accepts ISO-like date values', () => {
    const ctx = createContext({ [CAPGO_API_VERSION_HEADER]: '2024-10-08' })
    const version = resolveCapgoApiVersion(ctx)

    expect(version.normalized).toBe('2024.10.8')
    expect(version.equals('2024-10-08')).toBe(true)
    expect(version.before('2024-12-01')).toBe(true)
    expect(version.atLeast('2024-01-01')).toBe(true)
  })

  it('routes to handlers based on the requested version', () => {
    const ctx = createContext({ [CAPGO_API_VERSION_HEADER]: '2' })
    const version = resolveCapgoApiVersion(ctx)

    const result = version.handle({
      1: () => 'v1',
      2: () => 'v2',
    })

    expect(result).toBe('v2')
  })

  it('throws when the requested version is unsupported', () => {
    const ctx = createContext({ [CAPGO_API_VERSION_HEADER]: '3' })
    const version = resolveCapgoApiVersion(ctx)

    expect(() => version.handle({ 1: () => 'v1' })).toThrow(HTTPException)
  })

  it('throws when the header is not a valid version', () => {
    const ctx = createContext({ [CAPGO_API_VERSION_HEADER]: 'invalid' })

    expect(() => resolveCapgoApiVersion(ctx)).toThrow(HTTPException)
  })
})
