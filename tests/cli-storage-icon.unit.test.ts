import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/cli/index.ts'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(async () => true),
  upload: vi.fn(async () => ({ error: null })),
  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  apikey: {
    id: 42,
    key: 'test-api-key',
    user_id: '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (c: any, next: () => Promise<void>) => {
    c.set('apikey', mocks.apikey)
    c.set('capgkey', mocks.apikey.key)
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mocks.maybeSingle,
        }),
      }),
    }),
  }),
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: mocks.upload,
      }),
    },
  }),
}))

describe('private/cli storage icon upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkPermission.mockResolvedValue(true)
    mocks.upload.mockResolvedValue({ error: null })
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('uploads an icon for a new app with org.create_app permission', async () => {
    const orgId = '22222222-2222-4222-8222-222222222222'
    const response = await app.request('http://local/storage/icon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'com.example.app',
        org_id: orgId,
        content_base64: btoa('icon-bytes'),
        content_type: 'image/png',
        upsert: false,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { path?: string }
    expect(body.path).toBe(`org/${orgId}/com.example.app/icon`)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.create_app', { orgId })
    expect(mocks.upload).toHaveBeenCalled()
  })

  it('returns 409 conflict when upsert is false and storage already has the object', async () => {
    mocks.upload.mockResolvedValueOnce({ error: { statusCode: '409' } })
    const response = await app.request('http://local/storage/icon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: 'com.example.app',
        org_id: '22222222-2222-4222-8222-222222222222',
        content_base64: btoa('icon-bytes'),
        content_type: 'image/png',
        upsert: false,
      }),
    })

    expect(response.status).toBe(409)
    const body = await response.json() as { conflict?: boolean, path?: string }
    expect(body.conflict).toBe(true)
    expect(body.path).toContain('com.example.app/icon')
  })
})
