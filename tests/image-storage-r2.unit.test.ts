import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  checkPermissionInMemberOrgs: vi.fn(),
  cloudlogErr: vi.fn(),
  app: { data: null as unknown, error: null as unknown },
  client: {
    copyObject: vi.fn(),
    deleteObject: vi.fn(),
    exists: vi.fn(),
    getObject: vi.fn(),
    getPresignedUrl: vi.fn(),
    listObjects: vi.fn(),
    listObjectsGrouped: vi.fn(),
    statObject: vi.fn(),
  },
  supabaseStorage: {
    download: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  initS3: () => mocks.client,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: (...args: unknown[]) => mocks.cloudlogErr(...args),
  serializeError: (error: unknown) => error,
}))

const TEST_ENV: Record<string, string> = {
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  SUPABASE_URL: 'https://sb.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
}

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => TEST_ENV[key] ?? '',
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
  checkPermissionInMemberOrgs: (...args: unknown[]) => mocks.checkPermissionInMemberOrgs(...args),
}))

// mocks.app keeps the supabase-js `{ data, error }` shape of the apps lookup.
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: async () => ({
    query: async (text: string) => {
      expect(text).toContain('FROM public.apps')
      const { data, error } = mocks.app as { data: unknown, error: unknown }
      if (error)
        throw error
      return { rows: data ? [data] : [] }
    },
  }),
  closeClient: () => {},
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const storage = await import('../supabase/functions/_backend/utils/image_storage.ts')
const { canAccessImagePath, parseImagePath } = await import('../supabase/functions/_backend/utils/image_access.ts')

function context(userId: string | null = USER_ID) {
  return { get: (key: string) => (key === 'auth' ? (userId ? { userId } : undefined) : undefined) } as any
}

async function* yieldAll<T>(items: T[]) {
  for (const item of items)
    yield item
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.app = { data: null, error: null }
  mocks.client.exists.mockResolvedValue(false)
  mocks.client.getPresignedUrl.mockResolvedValue('https://r2.example/put')
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
  mocks.client.deleteObject.mockResolvedValue(undefined)
  mocks.checkPermission.mockResolvedValue(false)
  mocks.checkPermissionInMemberOrgs.mockResolvedValue(false)
})

describe('R2 image storage', () => {
  it('stores images under the images/ prefix with their content type', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await expect(storage.uploadImage(context(), `org/${ORG_ID}/logo/a.png`, bytes, { contentType: 'image/png', upsert: true })).resolves.toBe('ok')
    expect(mocks.client.exists).not.toHaveBeenCalled()
    expect(mocks.client.getPresignedUrl).toHaveBeenCalledWith('PUT', `images/org/${ORG_ID}/logo/a.png`, expect.objectContaining({
      parameters: expect.objectContaining({ 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('https://r2.example/put', expect.objectContaining({
      method: 'PUT',
      body: bytes,
      headers: expect.objectContaining({ 'Content-Type': 'image/png' }),
    }))
  })

  it('throws when the bucket rejects the upload', async () => {
    fetchMock.mockResolvedValue(new Response('<Error/>', { status: 403 }))
    await expect(storage.uploadImage(context(), `${USER_ID}/a.png`, new Uint8Array([1]), { upsert: true })).rejects.toThrow('status 403')
  })

  it('reports a conflict instead of overwriting without upsert', async () => {
    mocks.client.exists.mockResolvedValue(true)
    await expect(storage.uploadImage(context(), `${USER_ID}/a.png`, new Uint8Array([1]))).resolves.toBe('conflict')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when downloading a missing object', async () => {
    mocks.client.getObject.mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }))
    await expect(storage.downloadImage(context(), 'x/y.png')).resolves.toBeNull()
  })

  it('ignores missing objects on delete but surfaces other failures', async () => {
    mocks.client.deleteObject.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'NoSuchKey' }))
    await expect(storage.removeImages(context(), ['a/1.png', 'a/2.png'])).resolves.toBeUndefined()
    expect(mocks.client.deleteObject).toHaveBeenCalledWith('images/a/2.png')

    mocks.client.deleteObject.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }))
    await expect(storage.removeImages(context(), ['a/1.png'])).rejects.toThrow('boom')
  })

  it('lists one folder level as files and sub-folders', async () => {
    mocks.client.listObjectsGrouped.mockReturnValue(yieldAll([
      { type: 'CommonPrefix', prefix: `images/org/${ORG_ID}/logo/` },
      { type: 'CommonPrefix', prefix: `images/org/${ORG_ID}/com.app/` },
      { type: 'Object', key: `images/org/${ORG_ID}/stray.png` },
    ]))
    await expect(storage.listImageFolder(context(), `org/${ORG_ID}`)).resolves.toEqual([
      { name: 'logo', isFolder: true },
      { name: 'com.app', isFolder: true },
      { name: 'stray.png', isFolder: false },
    ])
    expect(mocks.client.listObjectsGrouped).toHaveBeenCalledWith({ prefix: `images/org/${ORG_ID}/`, delimiter: '/', maxResults: undefined })
  })

  it('removes a folder recursively without touching sibling prefixes', async () => {
    mocks.client.listObjects.mockReturnValue(yieldAll([
      { type: 'Object', key: `images/${USER_ID}/a.png` },
      { type: 'Object', key: `images/${USER_ID}/nested/b.png` },
    ]))
    await expect(storage.removeImageFolder(context(), USER_ID)).resolves.toBe(2)
    expect(mocks.client.listObjects).toHaveBeenCalledWith({ prefix: `images/${USER_ID}/` })
  })

  it.each(['', '/', '///'])('refuses to remove the whole images/ space (prefix %j)', async (prefix) => {
    await expect(storage.removeImageFolder(context(), prefix)).rejects.toThrow('non-empty folder')
    expect(mocks.client.listObjects).not.toHaveBeenCalled()
  })

  it('stops removing a folder once the deadline has passed', async () => {
    mocks.client.listObjects.mockReturnValue(yieldAll([
      { type: 'Object', key: `images/org/${ORG_ID}/a.png` },
      { type: 'Object', key: `images/org/${ORG_ID}/b.png` },
      { type: 'Object', key: `images/org/${ORG_ID}/c.png` },
    ]))
    let now = 1_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.client.deleteObject.mockImplementation(async () => {
      now += 600
    })
    try {
      await expect(storage.removeImageFolder(context(), `org/${ORG_ID}`, { deadline: 2_000 })).resolves.toBe(2)
      expect(mocks.client.deleteObject).toHaveBeenCalledTimes(2)
    }
    finally {
      spy.mockRestore()
    }
  })

  it('presigns GET URLs on the images/ key, capped at seven days', async () => {
    mocks.client.getPresignedUrl.mockResolvedValue('https://r2.example/signed')
    await expect(storage.presignImageUrl(context(), 'org/x/logo/a.png', 10 * 24 * 3600)).resolves.toBe('https://r2.example/signed')
    expect(mocks.client.getPresignedUrl).toHaveBeenCalledWith('GET', 'images/org/x/logo/a.png', { expirySeconds: 604800 })
  })
})

describe('image tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T12:00:00.999Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('round-trips the user it was issued to', async () => {
    const issued = await storage.createImageToken(context(), USER_ID)
    expect(issued?.token).toMatch(new RegExp(`^${USER_ID}\\.\\d+\\.[\\w-]+$`))
    expect(issued!.expiresAt - Math.floor(Date.now() / 1000)).toBe(storage.IMAGE_TOKEN_TTL_SECONDS)
    await expect(storage.verifyImageToken(context(), issued!.token)).resolves.toBe(USER_ID)
  })

  it('rejects a token moved to another user, extended, tampered or malformed', async () => {
    const { token } = (await storage.createImageToken(context(), USER_ID))!
    const [, expiresAt, signature] = token.split('.')
    await expect(storage.verifyImageToken(context(), `${OTHER_USER_ID}.${expiresAt}.${signature}`)).resolves.toBeNull()
    await expect(storage.verifyImageToken(context(), `${USER_ID}.${Number(expiresAt) + 10}.${signature}`)).resolves.toBeNull()
    await expect(storage.verifyImageToken(context(), `${USER_ID}.${expiresAt}.${signature.slice(0, -2)}AA`)).resolves.toBeNull()
    await expect(storage.verifyImageToken(context(), 'garbage')).resolves.toBeNull()
    await expect(storage.createImageToken(context(), 'not-a-uuid')).resolves.toBeNull()
  })

  it('rejects an expired token and caps the lifetime', async () => {
    const short = (await storage.createImageToken(context(), USER_ID, 60))!
    const long = (await storage.createImageToken(context(), USER_ID, 30 * 24 * 3600))!
    expect(long.expiresAt - Math.floor(Date.now() / 1000)).toBe(storage.IMAGE_TOKEN_TTL_SECONDS)

    vi.setSystemTime(Date.now() + 120_000)
    await expect(storage.verifyImageToken(context(), short.token)).resolves.toBeNull()
  })
})

describe('legacy Supabase image import', () => {
  const ICON = `org/${ORG_ID}/com.app/icon`
  const STORAGE = 'https://sb.example/storage/v1'
  const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 })
  const r2Puts = () => fetchMock.mock.calls.filter(([url]) => url === 'https://r2.example/put')

  function legacyEntry(updatedAt: string) {
    mocks.supabaseStorage.list.mockResolvedValue(Response.json([{ id: 'obj-1', name: 'icon', updated_at: updatedAt }]))
  }

  beforeEach(() => {
    // Routes the Storage REST calls to the handlers; anything else is the R2 PUT.
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === `${STORAGE}/object/list/images`)
        return mocks.supabaseStorage.list(init)
      if (url === `${STORAGE}/object/authenticated/images/${ICON}`)
        return mocks.supabaseStorage.download(init)
      if (url === `${STORAGE}/object/images`)
        return mocks.supabaseStorage.remove(init)
      return new Response(null, { status: 200 })
    })
    mocks.supabaseStorage.download.mockImplementation(async () => new Response(new Uint8Array([9, 9]), { headers: { 'content-type': 'image/png' } }))
    mocks.supabaseStorage.remove.mockImplementation(async () => Response.json([]))
  })

  it('moves a fresh legacy upload into R2 and removes the Supabase copy', async () => {
    legacyEntry('2026-10-26T12:00:00Z')
    mocks.client.statObject.mockRejectedValue(notFound())

    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(true)
    const listInit = mocks.supabaseStorage.list.mock.calls[0]![0] as RequestInit
    expect(listInit.method).toBe('POST')
    expect(listInit.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer service-key', apikey: 'service-key' }))
    expect(JSON.parse(listInit.body as string)).toEqual({
      limit: 100,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
      search: 'icon',
      prefix: `org/${ORG_ID}/com.app`,
    })
    expect(mocks.supabaseStorage.download).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer service-key' }),
    }))
    expect(mocks.client.getPresignedUrl).toHaveBeenCalledWith('PUT', `images/${ICON}`, expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('https://r2.example/put', expect.objectContaining({
      body: new Uint8Array([9, 9]),
      headers: expect.objectContaining({ 'Content-Type': 'image/png' }),
    }))
    const removeInit = mocks.supabaseStorage.remove.mock.calls[0]![0] as RequestInit
    expect(removeInit.method).toBe('DELETE')
    expect(JSON.parse(removeInit.body as string)).toEqual({ prefixes: [ICON] })
  })

  it('overwrites R2 when an old CLI re-uploaded the icon after it', async () => {
    legacyEntry('2026-10-26T12:00:00Z')
    mocks.client.statObject.mockResolvedValue({ lastModified: new Date('2026-10-26T11:00:00Z') })

    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(true)
    expect(r2Puts()).toHaveLength(1)
  })

  it('drops a stale migration leftover instead of overwriting a newer R2 upload', async () => {
    legacyEntry('2026-10-01T00:00:00Z')
    mocks.client.statObject.mockResolvedValue({ lastModified: new Date('2026-10-26T12:00:00Z') })

    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(false)
    expect(mocks.supabaseStorage.download).not.toHaveBeenCalled()
    expect(r2Puts()).toHaveLength(0)
    expect(mocks.supabaseStorage.remove).toHaveBeenCalledOnce()
  })

  it('does nothing when Supabase has no such object', async () => {
    mocks.supabaseStorage.list.mockResolvedValue(Response.json([{ id: null, name: 'icon' }]))
    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(false)
    expect(mocks.supabaseStorage.download).not.toHaveBeenCalled()
    expect(mocks.supabaseStorage.remove).not.toHaveBeenCalled()
    expect(r2Puts()).toHaveLength(0)
  })

  it.each([
    ['an error status', () => mocks.supabaseStorage.list.mockResolvedValue(new Response('boom', { status: 500 }))],
    ['a network error', () => mocks.supabaseStorage.list.mockRejectedValue(new TypeError('fetch failed'))],
  ])('logs and skips the import when the lookup fails with %s', async (_label, fail) => {
    fail()
    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(false)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cannot look up legacy Supabase image', path: ICON }))
    expect(mocks.supabaseStorage.download).not.toHaveBeenCalled()
    expect(mocks.supabaseStorage.remove).not.toHaveBeenCalled()
  })

  it('keeps the Supabase copy when the download fails', async () => {
    legacyEntry('2026-10-26T12:00:00Z')
    mocks.client.statObject.mockRejectedValue(notFound())
    // Storage answers a missing object with 400 "Object not found".
    mocks.supabaseStorage.download.mockImplementation(async () => Response.json({ error: 'not_found' }, { status: 400 }))

    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(false)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cannot download legacy Supabase image', path: ICON }))
    expect(r2Puts()).toHaveLength(0)
    expect(mocks.supabaseStorage.remove).not.toHaveBeenCalled()
  })

  it('still reports the import when removing the Supabase copy fails', async () => {
    legacyEntry('2026-10-26T12:00:00Z')
    mocks.client.statObject.mockRejectedValue(notFound())
    mocks.supabaseStorage.remove.mockImplementation(async () => new Response('denied', { status: 403 }))

    await expect(storage.importLegacySupabaseImage(context(), ICON)).resolves.toBe(true)
    expect(r2Puts()).toHaveLength(1)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'Could not remove the legacy Supabase image', path: ICON }))
  })
})

describe('image access rules', () => {
  it('parses the ownership layout and rejects unsafe paths', () => {
    expect(parseImagePath(`org/${ORG_ID}/logo/a.png`)).toEqual({ kind: 'org_logo', orgId: ORG_ID })
    expect(parseImagePath(`org/${ORG_ID}/com.app/icon`)).toEqual({ kind: 'app', orgId: ORG_ID, appId: 'com.app', fileName: 'icon' })
    expect(parseImagePath(`${USER_ID}/avatar.png`)).toEqual({ kind: 'user', userId: USER_ID })
    expect(parseImagePath('public/capgo.png')).toEqual({ kind: 'public' })
    expect(parseImagePath(`org/${ORG_ID}/com.app`)).toBeNull()
    expect(parseImagePath(`org/not-a-uuid/logo/a.png`)).toBeNull()
    expect(parseImagePath(`${USER_ID}/../x.png`)).toBeNull()
    expect(parseImagePath('bare.png')).toBeNull()
    expect(parseImagePath('someone/avatar.png')).toBeNull()
  })

  it('requires a signed-in caller', async () => {
    await expect(canAccessImagePath(context(null), 'public/capgo.png', 'read')).resolves.toBe(false)
  })

  it('lets users manage their own folder and blocks other users', async () => {
    await expect(canAccessImagePath(context(), `${USER_ID}/a.png`, 'write')).resolves.toBe(true)
    await expect(canAccessImagePath(context(), `${OTHER_USER_ID}/a.png`, 'write')).resolves.toBe(false)
    await expect(canAccessImagePath(context(), `${OTHER_USER_ID}/a.png`, 'delete')).resolves.toBe(false)
  })

  it('lets org member readers see a teammate avatar with one batched check', async () => {
    mocks.checkPermissionInMemberOrgs.mockResolvedValue(true)
    await expect(canAccessImagePath(context(), `${OTHER_USER_ID}/a.png`, 'read')).resolves.toBe(true)
    expect(mocks.checkPermissionInMemberOrgs).toHaveBeenCalledTimes(1)
    expect(mocks.checkPermissionInMemberOrgs).toHaveBeenCalledWith(expect.anything(), 'org.read_members', OTHER_USER_ID)
    expect(mocks.checkPermission).not.toHaveBeenCalled()
  })

  it('maps org logo access to org permissions', async () => {
    mocks.checkPermission.mockImplementation(async (_c: unknown, permission: string) => permission === 'org.read')
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/logo/a.png`, 'read')).resolves.toBe(true)
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/logo/a.png`, 'write')).resolves.toBe(false)
    expect(mocks.checkPermission).toHaveBeenCalledWith(expect.anything(), 'org.update_settings', { orgId: ORG_ID })
  })

  it('allows a create-only grant to write the onboarding icon of a new app only', async () => {
    mocks.checkPermission.mockImplementation(async (_c: unknown, permission: string) => permission === 'org.create_app')
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/com.new/icon`, 'write')).resolves.toBe(true)
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/com.new/other.png`, 'write')).resolves.toBe(false)

    mocks.app = { data: { owner_org: ORG_ID, need_onboarding: false }, error: null }
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/com.new/icon`, 'write')).resolves.toBe(false)

    mocks.app = { data: { owner_org: ORG_ID, need_onboarding: true }, error: null }
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/com.new/icon`, 'write')).resolves.toBe(true)
  })

  it('refuses app image writes when the app belongs to another org', async () => {
    mocks.checkPermission.mockResolvedValue(true)
    mocks.app = { data: { owner_org: '44444444-4444-4444-8444-444444444444', need_onboarding: true }, error: null }
    await expect(canAccessImagePath(context(), `org/${ORG_ID}/com.app/icon`, 'write')).resolves.toBe(false)
  })

  it('keeps public assets read-only', async () => {
    await expect(canAccessImagePath(context(), 'public/capgo.png', 'read')).resolves.toBe(true)
    await expect(canAccessImagePath(context(), 'public/capgo.png', 'write')).resolves.toBe(false)
  })
})
