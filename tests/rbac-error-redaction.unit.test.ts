import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlogErr: mocks.cloudlogErr,
}))

const { checkPermissionsBatchPg, sanitizePermissionCheckError } = await import('../supabase/functions/_backend/utils/rbac.ts')

const KEY = 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'
const OTHER_KEY = '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

function contextWith(values: Record<string, unknown>) {
  return { get: (name: string) => values[name] } as any
}

describe('permission check error logging', () => {
  it('drops drizzle bound params and redacts the API key everywhere', () => {
    const cause = Object.assign(new Error(`connection reset while running for ${KEY}`), { code: '08006' })
    const error = Object.assign(new Error(`Failed query: SELECT public.rbac_check_permissions($1, $2)\nparams: ${KEY},[{"permission":"app.read"}]`), { cause })
    const logged = sanitizePermissionCheckError(error, [KEY])
    expect(JSON.stringify(logged)).not.toContain(KEY)
    expect(logged.message).toBe('Failed query: SELECT public.rbac_check_permissions($1, $2)')
    expect(logged.cause).toMatchObject({ code: '08006', message: 'connection reset while running for [redacted]' })
  })

  it('handles non-error values', () => {
    expect(sanitizePermissionCheckError('boom').message).toBe('boom')
    expect(sanitizePermissionCheckError(undefined).cause).toBeUndefined()
  })

  it.each([
    ['missing from the context', {}],
    ['different from the context key', { capgkey: OTHER_KEY }],
  ])('redacts the bound key in the handler when it is %s', async (_label, context) => {
    mocks.cloudlogErr.mockClear()
    const cause = Object.assign(new Error(`driver echoed ${KEY}`), { code: '57P01' })
    const drizzle = {
      execute: async () => {
        throw Object.assign(new Error(`Failed query: SELECT 1\nparams: ${KEY}`), { cause })
      },
    }
    const results = await checkPermissionsBatchPg(contextWith({ requestId: 'r1', ...context }), [{ permission: 'app.read', scope: { appId: 'com.demo.app' } }], drizzle as any, 'user-1', KEY).catch(() => [false])
    expect(results).toEqual([false])
    expect(mocks.cloudlogErr).toHaveBeenCalled()
    expect(JSON.stringify(mocks.cloudlogErr.mock.calls)).not.toContain(KEY)
  })
})
