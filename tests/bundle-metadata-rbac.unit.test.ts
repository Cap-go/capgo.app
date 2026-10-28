import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPermissionMock = vi.fn()
const queryMock = vi.fn()
const withRlsContextMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (c: any, next: () => Promise<void>) => {
    c.set('apikey', { key: 'test-apikey', user_id: 'user-1' })
    c.set('auth', { userId: 'user-1', authType: 'apikey', apikey: { key: 'test-apikey', user_id: 'user-1' }, jwt: null })
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => checkPermissionMock(...args),
}))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: (_c: unknown, apikey: string) => ({ kind: 'apikey', apikey }),
  withRlsContext: (_c: unknown, principal: unknown, run: (client: unknown) => unknown) => {
    withRlsContextMock(principal)
    return run({ query: queryMock })
  },
}))

const { app } = await import('../supabase/functions/_backend/public/bundle/update_metadata.ts')

function postJson(body: unknown) {
  return new Request('http://local/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('bundle metadata RBAC guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissionMock.mockResolvedValue(true)
    queryMock.mockImplementation(async (text: string) => text.startsWith('SELECT')
      ? { rows: [{ id: 123 }] }
      : { rows: [] })
  })

  it('rejects metadata writes when upload permission is denied', async () => {
    checkPermissionMock.mockResolvedValue(false)

    const response = await app.request(postJson({
      app_id: 'com.example.app',
      version_id: 123,
      comment: 'blocked update',
    }))

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('You can\'t update metadata for this app')
    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', { appId: 'com.example.app' })
    expect(withRlsContextMock).not.toHaveBeenCalled()
  })

  it('allows metadata writes when upload permission is granted', async () => {
    const response = await app.request(postJson({
      app_id: 'com.example.app',
      version_id: 123,
      comment: 'allowed update',
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
    })
    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'app.upload_bundle', { appId: 'com.example.app' })
    expect(withRlsContextMock).toHaveBeenCalledWith({ kind: 'apikey', apikey: 'test-apikey' })
    expect(queryMock).toHaveBeenLastCalledWith(
      'UPDATE public.app_versions SET comment = $3 WHERE app_id = $1 AND id = $2',
      ['com.example.app', 123, 'allowed update'],
    )
  })
})
