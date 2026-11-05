import { describe, expect, it } from 'vitest'
import { getAuthHeaders, getEndpointUrl, USER_EMAIL, USER_ID, USER_ID_NONMEMBER, USER_PASSWORD } from './test-utils'

interface QueryResponse {
  data: unknown
  error: { message: string, code?: string } | null
  count: number | null
  status: number
}

async function query(body: unknown, headers: Record<string, string> = {}) {
  return fetch(getEndpointUrl('/private/console/query'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('[POST] /private/console/query', () => {
  it('runs an allowlisted table query with the caller session', async () => {
    const response = await query({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id, email'] }, { method: 'eq', args: ['id', USER_ID] }, { method: 'single', args: [] }],
    }, await getAuthHeaders())
    expect(response.status).toBe(200)
    const body = await response.json() as QueryResponse
    expect(body.error).toBeNull()
    expect(body.data).toMatchObject({ id: USER_ID })
  })

  it('runs an allowlisted rpc with the caller session', async () => {
    const response = await query({ kind: 'rpc', name: 'is_platform_admin', args: [], operations: [] }, await getAuthHeaders())
    expect(response.status).toBe(200)
    const body = await response.json() as QueryResponse
    expect(body.error).toBeNull()
    expect(typeof body.data).toBe('boolean')
  })

  it('keeps RLS: a user outside the caller\'s organizations is not visible', async () => {
    const response = await query({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id'] }, { method: 'eq', args: ['id', USER_ID_NONMEMBER] }],
    }, await getAuthHeaders())
    expect(response.status).toBe(200)
    const body = await response.json() as QueryResponse
    expect(body.error).toBeNull()
    // The row exists, but RLS hides users who share no organization with the caller.
    expect(body.data).toEqual([])
  })

  it('returns PostgREST errors in the body even when throwOnError was recorded', async () => {
    const response = await query({
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id'] }, { method: 'eq', args: ['id', USER_ID_NONMEMBER] }, { method: 'single', args: [] }, { method: 'throwOnError', args: [] }],
    }, await getAuthHeaders())
    expect(response.status).toBe(200)
    const body = await response.json() as QueryResponse
    expect(body.data).toBeNull()
    expect(body.error?.code).toBe('PGRST116')
  })

  it('rejects tables outside the allowlist', async () => {
    const response = await query({ kind: 'table', name: 'stripe_info', args: [], operations: [{ method: 'select', args: ['*'] }] }, await getAuthHeaders())
    expect(response.status).toBe(403)
  })

  it('rejects builder methods outside the allowlist', async () => {
    const response = await query({ kind: 'table', name: 'apps', args: [], operations: [{ method: 'explain', args: [] }] }, await getAuthHeaders())
    expect(response.status).toBe(400)
  })

  it('refuses tokens that are not user sessions before replaying anything', async () => {
    const forge = (claims: Record<string, unknown>) => `Bearer ${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
    const anonRole = await query({ kind: 'table', name: 'apps', args: [], operations: [{ method: 'select', args: ['id'] }] }, { Authorization: forge({ role: 'anon' }) })
    expect(anonRole.status).toBe(401)
    const garbage = await query({ kind: 'table', name: 'apps', args: [], operations: [{ method: 'select', args: ['id'] }] }, { Authorization: 'Bearer not-a-jwt' })
    expect(garbage.status).toBe(401)
  })

  it('lets the database reject a forged user token instead of trusting its claims', async () => {
    const forged = `Bearer ${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.forged`
    const response = await query({ kind: 'table', name: 'users', args: [], operations: [{ method: 'select', args: ['id'] }] }, { Authorization: forged })
    const body = await response.json() as QueryResponse
    expect(body.data).toBeNull()
    expect(body.error).not.toBeNull()
  })

  it('requires a session for table queries', async () => {
    const response = await query({ kind: 'table', name: 'apps', args: [], operations: [{ method: 'select', args: ['id'] }] })
    expect(response.status).toBe(401)
  })

  it('allows only the anonymous deleted-account probe without a session', async () => {
    const probe = await query({ kind: 'rpc', name: 'is_not_deleted', args: [{ email_check: 'nobody@example.com' }], operations: [] })
    expect(probe.status).toBe(200)
    const other = await query({ kind: 'rpc', name: 'is_platform_admin', args: [], operations: [] })
    expect(other.status).toBe(401)
  })
})

describe('[ANY] /private/console/auth/*', () => {
  it('relays a password grant to the auth provider and returns its session', async () => {
    const response = await fetch(getEndpointUrl('/private/console/auth/token?grant_type=password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { access_token?: string, refresh_token?: string, user?: { id: string } }
    expect(body.user?.id).toBe(USER_ID)
    expect(typeof body.access_token).toBe('string')
    expect(typeof body.refresh_token).toBe('string')

    const me = await fetch(getEndpointUrl('/private/console/auth/user'), { headers: { Authorization: `Bearer ${body.access_token}` } })
    expect(me.status).toBe(200)
    expect((await me.json() as { id: string }).id).toBe(USER_ID)
  })

  it('surfaces auth provider errors with their codes', async () => {
    const response = await fetch(getEndpointUrl('/private/console/auth/token?grant_type=password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: 'wrong-password' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { error_code?: string }).error_code).toBe('invalid_credentials')
  })

  it('never relays admin endpoints', async () => {
    const response = await fetch(getEndpointUrl('/private/console/auth/admin/users'), { headers: await getAuthHeaders() })
    expect(response.status).toBe(404)
  })
})
