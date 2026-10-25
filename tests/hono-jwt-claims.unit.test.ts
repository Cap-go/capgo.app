import { afterEach, describe, expect, it, vi } from 'vitest'
import { getClaimsFromJWT } from '../supabase/functions/_backend/utils/hono_jwt.ts'

const getClaims = vi.hoisted(() => vi.fn())

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getClaims } }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => {
    if (key === 'SUPABASE_URL')
      return 'https://example.supabase.co'
    if (key === 'SUPABASE_ANON_KEY')
      return 'anon-key-value'
    return ''
  },
}))

const context = {} as never

function claims(exp: number) {
  return { sub: 'user-1', role: 'authenticated', exp }
}

describe('getClaimsFromJWT cache', () => {
  afterEach(() => {
    vi.useRealTimers()
    getClaims.mockReset()
  })

  it('reuses a successful verification and does not cache a failure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const exp = Math.floor(Date.now() / 1000) + 3600
    getClaims.mockResolvedValueOnce({ data: null, error: { message: 'invalid' } })
    await expect(getClaimsFromJWT(context, 'Bearer token-miss')).resolves.toBeNull()

    getClaims.mockResolvedValue({ data: { claims: claims(exp) }, error: null })
    const first = await getClaimsFromJWT(context, 'Bearer token-hit')
    const second = await getClaimsFromJWT(context, 'Bearer token-hit')
    expect(first).toMatchObject({ sub: 'user-1', role: 'authenticated' })
    expect(second).toMatchObject({ sub: 'user-1' })
    expect(second).not.toBe(first)
    expect(getClaims).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    await getClaimsFromJWT(context, 'Bearer token-hit')
    expect(getClaims).toHaveBeenCalledTimes(3)
  })

  it('drops a cached result at the token exp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const exp = Math.floor(Date.now() / 1000) + 10
    getClaims.mockResolvedValue({ data: { claims: claims(exp) }, error: null })
    await getClaimsFromJWT(context, 'Bearer token-exp')
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    await getClaimsFromJWT(context, 'Bearer token-exp')
    expect(getClaims).toHaveBeenCalledTimes(2)
  })
})
