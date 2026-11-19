import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gotrueAdmin, GotrueAdminError } from '../supabase/functions/_backend/utils/gotrue_admin.ts'

const ENV: Record<string, string> = { SUPABASE_URL: 'https://project.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }
const USER_ID = '11111111-1111-4111-8111-111111111111'
const fetchMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => ENV[key] ?? '',
}))

function context(env: Record<string, unknown> = {}) {
  return { env } as unknown as Context
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function lastCall(mock = fetchMock) {
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('gotrueAdmin requests', () => {
  it('calls hosted Supabase Auth with the same headers as supabase-js', async () => {
    fetchMock.mockResolvedValue(json({ id: USER_ID, email: 'a@b.co', app_metadata: { provider: 'sso:x' }, user_metadata: {} }))
    const { data, error } = await gotrueAdmin(context()).getUserById(USER_ID)

    expect(error).toBeNull()
    expect(data.user?.app_metadata.provider).toBe('sso:x')
    const call = lastCall()
    expect(call.url).toBe(`https://project.supabase.co/auth/v1/admin/users/${USER_ID}`)
    expect(call.init.method).toBe('GET')
    expect(call.body).toBeUndefined()
    expect(call.headers.get('apikey')).toBe('sb_secret_test')
    expect(call.headers.get('authorization')).toBe('Bearer sb_secret_test')
    expect(call.headers.get('x-supabase-api-version')).toBe('2024-01-01')
    expect(call.headers.has('content-type')).toBe(false)
  })

  it('goes through the GOTRUE binding when the environment has one', async () => {
    const bindingFetch = vi.fn(async () => json({ id: USER_ID, app_metadata: {}, user_metadata: {} }))
    await gotrueAdmin(context({ GOTRUE: { fetch: bindingFetch } })).getUserById(USER_ID)

    expect(fetchMock).not.toHaveBeenCalled()
    const call = lastCall(bindingFetch)
    expect(call.url).toBe(`https://gotrue/admin/users/${USER_ID}`)
    expect(call.headers.get('authorization')).toBe('Bearer sb_secret_test')
  })

  it('sends createUser, updateUserById and deleteUser like supabase-js', async () => {
    fetchMock.mockImplementation(async () => json({ id: USER_ID, app_metadata: {}, user_metadata: {} }))
    const admin = gotrueAdmin(context())

    const created = await admin.createUser({ email: 'a@b.co', password: 'pw', email_confirm: true, id: USER_ID })
    expect(created.data.user?.id).toBe(USER_ID)
    let call = lastCall()
    expect([call.init.method, call.url]).toEqual(['POST', 'https://project.supabase.co/auth/v1/admin/users'])
    expect(call.body).toEqual({ email: 'a@b.co', password: 'pw', email_confirm: true, id: USER_ID })
    expect(call.headers.get('content-type')).toBe('application/json;charset=UTF-8')

    await admin.updateUserById(USER_ID, { app_metadata: { offer: 'direct' } })
    call = lastCall()
    expect([call.init.method, call.url]).toEqual(['PUT', `https://project.supabase.co/auth/v1/admin/users/${USER_ID}`])
    expect(call.body).toEqual({ app_metadata: { offer: 'direct' } })

    fetchMock.mockResolvedValueOnce(json({}))
    expect(await admin.deleteUser(USER_ID)).toEqual({ error: null })
    call = lastCall()
    expect([call.init.method, call.url]).toEqual(['DELETE', `https://project.supabase.co/auth/v1/admin/users/${USER_ID}`])
    expect(call.body).toEqual({ should_soft_delete: false })
  })

  it('throws on a non-UUID user id before any request, like supabase-js', async () => {
    const admin = gotrueAdmin(context())
    for (const id of ['.', '..', '../settings', 'not-a-uuid']) {
      await expect(admin.getUserById(id)).rejects.toThrow('Expected parameter to be UUID')
      await expect(admin.updateUserById(id, {})).rejects.toThrow('Expected parameter to be UUID')
      await expect(admin.deleteUser(id)).rejects.toThrow('Expected parameter to be UUID')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns an error instead of a user when a 200 body has no user', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    expect(await gotrueAdmin(context()).getUserById(USER_ID)).toMatchObject({ data: { user: null }, error: { status: 0 } })
    fetchMock.mockResolvedValueOnce(json({ users: [] }))
    expect(await gotrueAdmin(context()).getUserById(USER_ID)).toMatchObject({ data: { user: null }, error: { status: 0 } })
  })

  it('splits generateLink into properties and user like supabase-js', async () => {
    fetchMock.mockResolvedValue(json({ id: USER_ID, email: 'a@b.co', app_metadata: {}, user_metadata: {}, action_link: 'https://link', email_otp: '123456', hashed_token: 'hash', redirect_to: 'https://console', verification_type: 'magiclink' }))
    const { data, error } = await gotrueAdmin(context()).generateLink({ type: 'magiclink', email: 'a@b.co' })

    expect(error).toBeNull()
    expect(data.properties).toEqual({ action_link: 'https://link', email_otp: '123456', hashed_token: 'hash', redirect_to: 'https://console', verification_type: 'magiclink' })
    expect(data.user).toEqual({ id: USER_ID, email: 'a@b.co', app_metadata: {}, user_metadata: {} })
    const call = lastCall()
    expect([call.init.method, call.url]).toEqual(['POST', 'https://project.supabase.co/auth/v1/admin/generate_link'])
    expect(call.body).toEqual({ type: 'magiclink', email: 'a@b.co' })
  })
})

describe('gotrueAdmin errors', () => {
  it('reads message and code the way supabase-js does', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'email_exists', message: 'A user with this email address has already been registered' }, 422))
    const created = await gotrueAdmin(context()).createUser({ email: 'a@b.co' })
    expect(created.data.user).toBeNull()
    expect(created.error).toBeInstanceOf(GotrueAdminError)
    expect(created.error).toMatchObject({ status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' })

    // Older GoTrue format: numeric `code`, string `error_code`, `msg`.
    fetchMock.mockResolvedValueOnce(json({ code: 404, error_code: 'user_not_found', msg: 'User not found' }, 404))
    const missing = await gotrueAdmin(context()).getUserById(USER_ID)
    expect(missing.error).toMatchObject({ status: 404, code: 'user_not_found', message: 'User not found' })

    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'Bad token' }, 401))
    expect((await gotrueAdmin(context()).deleteUser(USER_ID)).error).toMatchObject({ status: 401, code: undefined, message: 'Bad token' })
  })

  it('returns a non-JSON error body as the message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream down', { status: 503 }))
    expect((await gotrueAdmin(context()).getUserById(USER_ID)).error).toMatchObject({ status: 503, message: 'upstream down' })
  })

  it('returns a failed response stream or a non-object 2xx body as an error', async () => {
    const broken = new Response(new ReadableStream({ pull: controller => controller.error(new Error('stream reset')) }), { status: 200 })
    fetchMock.mockResolvedValueOnce(broken)
    expect(await gotrueAdmin(context()).generateLink({ type: 'magiclink', email: 'a@b.co' })).toMatchObject({ data: { properties: null, user: null }, error: { status: 0, message: 'stream reset' } })

    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    expect(await gotrueAdmin(context()).generateLink({ type: 'magiclink', email: 'a@b.co' })).toMatchObject({ data: { properties: null, user: null }, error: { status: 0 } })

    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    expect((await gotrueAdmin(context()).deleteUser(USER_ID)).error).toMatchObject({ status: 0, message: 'Invalid JSON from auth server' })
  })

  it('returns a failed fetch as status 0 instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    const { data, error } = await gotrueAdmin(context()).generateLink({ type: 'magiclink', email: 'a@b.co' })
    expect(data).toEqual({ properties: null, user: null })
    expect(error).toMatchObject({ status: 0, message: 'network down' })
  })
})
