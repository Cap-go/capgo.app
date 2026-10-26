import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/console_data'

const mocks = vi.hoisted(() => ({
  canAccess: vi.fn(),
  createToken: vi.fn(),
  download: vi.fn(),
  exists: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  verifyToken: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  useCors: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: (c: any) => c.req.json(),
  quickError: (status: number, error: string) => Response.json({ error }, { status }),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer caller-jwt')
    c.set('auth', { userId: 'caller', authType: 'jwt' })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/private/console_query_run.ts', () => ({ runConsoleQuery: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => key === 'SUPABASE_URL' ? 'https://storage.example.com' : '',
}))
vi.mock('../supabase/functions/_backend/utils/image_access.ts', () => ({
  canAccessImagePath: (_c: unknown, ...args: unknown[]) => mocks.canAccess(...args),
}))
vi.mock('../supabase/functions/_backend/utils/image_storage.ts', () => ({
  createImageReadToken: (_c: unknown, ...args: unknown[]) => mocks.createToken(...args),
  downloadImage: (_c: unknown, ...args: unknown[]) => mocks.download(...args),
  imageExists: (_c: unknown, ...args: unknown[]) => mocks.exists(...args),
  removeImages: (_c: unknown, ...args: unknown[]) => mocks.remove(...args),
  uploadImage: (_c: unknown, ...args: unknown[]) => mocks.upload(...args),
  verifyImageReadToken: (_c: unknown, ...args: unknown[]) => mocks.verifyToken(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canAccess.mockResolvedValue(true)
  mocks.createToken.mockResolvedValue('fixture-capability')
  mocks.exists.mockResolvedValue(true)
  mocks.remove.mockResolvedValue(undefined)
  mocks.upload.mockResolvedValue('ok')
  mocks.verifyToken.mockResolvedValue(true)
})

function sign(path: string) {
  return app.request('https://api.example.com/images/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, expiresIn: 60 }),
  })
}

describe('console image proxy', () => {
  it('returns a Capgo API image URL after checking the caller may read the path', async () => {
    const response = await sign('org/logo.png')
    const { data } = await response.json() as { data: { signedUrl: string } }
    const url = new URL(data.signedUrl)
    expect(url.origin).toBe('https://api.example.com')
    // Derived from the request URL, so it works behind any mount path or proxy.
    expect(url.pathname).toBe('/images/read')
    expect(url.searchParams.get('path')).toBe('org/logo.png')
    expect(url.searchParams.get('token')).toBe('fixture-capability')
    expect(mocks.canAccess).toHaveBeenCalledWith('org/logo.png', 'read')
    expect(mocks.createToken).toHaveBeenCalledWith('org/logo.png', 60)
  })

  it('answers like storage when the caller may not read the path or it is missing', async () => {
    mocks.canAccess.mockResolvedValueOnce(false)
    const denied = await (await sign('org/logo.png')).json() as { error: { statusCode: string } }
    expect(denied.error.statusCode).toBe('404')
    expect(mocks.createToken).not.toHaveBeenCalled()

    mocks.exists.mockResolvedValueOnce(false)
    const missing = await (await sign('org/logo.png')).json() as { error: { statusCode: string } }
    expect(missing.error.statusCode).toBe('404')
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  it('signs a legacy storage URL only when it comes from the storage origin', async () => {
    const ours = await sign('https://storage.example.com/storage/v1/object/public/%69mages/org/my%20logo.png')
    const { data } = await ours.json() as { data: { signedUrl: string } }
    expect(mocks.createToken).toHaveBeenCalledWith('org/my logo.png', 60)
    expect(new URL(data.signedUrl).searchParams.get('path')).toBe('org/my logo.png')

    mocks.createToken.mockClear()
    const foreign = await sign('https://evil.example/storage/v1/object/public/%69mages/org/logo.png')
    expect(foreign.status).toBe(400)
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  it('streams image bytes from R2 for a valid capability', async () => {
    mocks.download.mockResolvedValue(new Response('fixture-image', { headers: { 'content-type': 'image/png' } }))
    const response = await app.request('https://api.example.com/images/read?path=org%2Fmy%20logo.png&token=fixture-capability')
    expect(await response.text()).toBe('fixture-image')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(mocks.verifyToken).toHaveBeenCalledWith('org/my logo.png', 'fixture-capability')
    expect(mocks.download).toHaveBeenCalledWith('org/my logo.png')
  })

  it('does not serve an expired or invalid capability', async () => {
    mocks.verifyToken.mockResolvedValue(false)
    const response = await app.request('https://api.example.com/images/read?path=org%2Flogo.png&token=expired-capability')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'image_unavailable' })
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('returns 404 when the object is gone and 502 when R2 fails', async () => {
    mocks.download.mockResolvedValueOnce(null)
    expect((await app.request('https://api.example.com/images/read?path=org%2Flogo.png&token=t')).status).toBe(404)
    mocks.download.mockRejectedValueOnce(new Error('r2 down'))
    expect((await app.request('https://api.example.com/images/read?path=org%2Flogo.png&token=t')).status).toBe(502)
  })

  it('rejects traversal before making a storage request', async () => {
    const response = await app.request('https://api.example.com/images/read?path=..%2Fother-bucket%2Fsecret&token=fixture-capability')
    expect(response.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('rejects traversal in upload paths before touching storage', async () => {
    const response = await app.request('https://api.example.com/images/upload', {
      method: 'POST',
      headers: { 'x-image-path': '../other-bucket/x', 'content-type': 'image/png' },
      body: 'bytes',
    })
    expect(response.status).toBe(400)
    expect(mocks.canAccess).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it('uploads to R2 only when the caller may write the path', async () => {
    const upload = (path: string) => app.request('https://api.example.com/images/upload', {
      method: 'POST',
      headers: { 'x-image-path': path, 'x-image-upsert': 'true', 'content-type': 'image/png' },
      body: 'bytes',
    })

    const ok = await (await upload('caller/avatar.png')).json() as { data: { path: string }, error: unknown }
    expect(ok).toEqual({ data: { path: 'caller/avatar.png', fullPath: 'images/caller/avatar.png' }, error: null })
    expect(mocks.canAccess).toHaveBeenCalledWith('caller/avatar.png', 'write')
    expect(mocks.upload).toHaveBeenCalledWith('caller/avatar.png', expect.any(Uint8Array), { contentType: 'image/png', upsert: true })

    mocks.canAccess.mockResolvedValueOnce(false)
    mocks.upload.mockClear()
    const denied = await (await upload('someone/avatar.png')).json() as { error: { statusCode: string } }
    expect(denied.error.statusCode).toBe('403')
    expect(mocks.upload).not.toHaveBeenCalled()

    mocks.upload.mockResolvedValueOnce('conflict')
    const conflict = await (await upload('caller/avatar.png')).json() as { error: { statusCode: string } }
    expect(conflict.error.statusCode).toBe('409')
  })

  it('removes only the paths the caller may delete', async () => {
    mocks.canAccess.mockImplementation(async (path: string) => path.startsWith('caller/'))
    const response = await app.request('https://api.example.com/images/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['caller/a.png', 'someone/b.png'] }),
    })
    expect(await response.json()).toEqual({ data: [{ name: 'caller/a.png' }], error: null })
    expect(mocks.remove).toHaveBeenCalledWith(['caller/a.png'])
  })
})
