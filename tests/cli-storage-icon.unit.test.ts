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
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mocks.maybeSingle,
        }),
      }),
    }),
    storage: {
      from: () => ({
        upload: mocks.upload,
      }),
    },
  }),
}))

const ORG_ID = '22222222-2222-4222-8222-222222222222'

function requestIcon(overrides: Record<string, unknown> = {}) {
  return app.request('http://local/storage/icon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: 'com.example.app',
      org_id: ORG_ID,
      content_base64: btoa('icon-bytes'),
      content_type: 'image/png',
      upsert: true,
      ...overrides,
    }),
  })
}

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

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream'])('rejects non-raster content type %s', async (contentType) => {
    const response = await requestIcon({ content_type: contentType })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Icon must be a PNG, JPEG, WebP, or GIF image')
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('stores the normalized raster content type', async () => {
    const response = await requestIcon({ content_type: 'IMAGE/WEBP; charset=binary' })
    expect(response.status).toBe(200)
    expect(mocks.upload).toHaveBeenCalledWith(
      `org/${ORG_ID}/com.example.app/icon`,
      expect.any(Uint8Array),
      { contentType: 'image/webp', upsert: true },
    )
  })

  it('requires app.update_settings when the app already exists, even if hidden from the key', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { app_id: 'com.example.app', owner_org: ORG_ID }, error: null })
    mocks.checkPermission.mockImplementation(async (_c: unknown, permission: string) => permission === 'org.create_app')

    const response = await requestIcon()
    expect(response.status).toBe(403)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'app.update_settings', { appId: 'com.example.app' })
    expect(mocks.checkPermission).not.toHaveBeenCalledWith(expect.anything(), 'org.create_app', expect.anything())
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('rejects uploads when the existing app belongs to another org', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { app_id: 'com.example.app', owner_org: '33333333-3333-4333-8333-333333333333' }, error: null })

    const response = await requestIcon()
    expect(response.status).toBe(403)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})
