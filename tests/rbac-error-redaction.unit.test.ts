import { describe, expect, it } from 'vitest'
import { sanitizePermissionCheckError } from '../supabase/functions/_backend/utils/rbac.ts'

const KEY = 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'

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
})
