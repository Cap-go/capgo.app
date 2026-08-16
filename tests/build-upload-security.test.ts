import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tusProxy } from '../supabase/functions/_backend/public/build/upload.ts'

const { mockSupabaseApikey, mockCheckPermission, mockGetEnv } = vi.hoisted(() => ({
  mockSupabaseApikey: vi.fn(),
  mockCheckPermission: vi.fn(),
  mockGetEnv: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: mockSupabaseApikey,
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: mockCheckPermission,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: mockGetEnv,
}))

describe('build upload proxy security', () => {
  const jobId = 'job-traversal-test'
  const appId = 'com.test.traversal.app'
  const orgId = 'org-traversal'
  const validUploadPath = `orgs/${orgId}/apps/${appId}/native-builds/file.zip`
  const jobUploadResource = 'file.zip'
  const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const defaultBuildRequest = {
    app_id: appId,
    owner_org: orgId,
    builder_job_id: jobId,
    upload_path: validUploadPath,
    upload_expires_at: futureExpiry(),
    status: 'pending',
  }

  const createQueryBuilder = (data: Record<string, unknown> = defaultBuildRequest) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data,
      error: null,
    }),
  })
  let queryBuilder: ReturnType<typeof createQueryBuilder>

  const fakeContext = (url: string, method = 'POST') => {
    const request = new Request(url, {
      method,
      headers: {
        'Tus-Resumable': '1.0.0',
      },
    })

    return {
      req: {
        url: request.url,
        method: request.method,
        raw: request,
        header: (name: string) => request.headers.get(name),
      },
      get: vi.fn().mockReturnValue('test-request-id'),
    }
  }

  beforeEach(() => {
    mockGetEnv.mockClear()
    mockCheckPermission.mockClear()
    mockSupabaseApikey.mockClear()
    queryBuilder = createQueryBuilder()
    mockSupabaseApikey.mockReturnValue({
      from: vi.fn().mockReturnValue(queryBuilder),
    })
    mockGetEnv.mockImplementation((_, key: string) => {
      if (key === 'BUILDER_URL') {
        return 'https://builder.capgo.app'
      }
      if (key === 'BUILDER_API_KEY') {
        return 'builder-secret'
      }
      return null
    })
    mockCheckPermission.mockResolvedValue(true)
  })

  it('rejects path traversal attempts before forwarding to builder', async () => {
    const context = fakeContext(`http://localhost/build/upload/${jobId}/%2e%2e%2Fjobs`, 'PATCH')

    let error: HTTPException | undefined
    try {
      await tusProxy(context as any, jobId, { user_id: 'user-test', key: 'api-test' } as any)
    }
    catch (err) {
      expect(err).toBeInstanceOf(HTTPException)
      if (!(err instanceof HTTPException)) {
        throw err
      }
      error = err
    }

    if (!error) {
      throw new Error('Expected tusProxy to reject with HTTPException')
    }
    expect(error.cause).toMatchObject({
      error: 'invalid_path',
      message: 'Invalid upload path',
    })
  })

  it('rejects invalidly encoded paths before forwarding to builder', async () => {
    const context = fakeContext(`http://localhost/build/upload/${jobId}/%`, 'PATCH')

    let error: HTTPException | undefined
    try {
      await tusProxy(context as any, jobId, { user_id: 'user-test', key: 'api-test' } as any)
    }
    catch (err) {
      expect(err).toBeInstanceOf(HTTPException)
      if (!(err instanceof HTTPException)) {
        throw err
      }
      error = err
    }

    if (!error) {
      throw new Error('Expected tusProxy to reject with HTTPException')
    }
    expect(error.cause).toMatchObject({
      error: 'invalid_path',
      message: 'Invalid upload path encoding.',
    })
  })

  it('does not reject canonical upload suffixes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 201,
      headers: {
        Location: 'https://builder.capgo.app/upload/file.zip',
      },
    }))

    try {
      const context = fakeContext(`http://localhost/build/upload/${jobId}/${jobUploadResource}`, 'PATCH')
      const response = await tusProxy(context as any, jobId, { user_id: 'user-test', key: 'api-test' } as any)

      expect(response.status).toBe(201)
      expect(fetchMock).toHaveBeenCalledWith(
        `https://builder.capgo.app/upload/${jobUploadResource}`,
        expect.anything(),
      )
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('keeps TUS resume state discoverable between PATCH chunks', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: {
          'Upload-Offset': '4',
          'Tus-Resumable': '1.0.0',
        },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          'Upload-Offset': '4',
          'Tus-Resumable': '1.0.0',
        },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 204,
        headers: {
          'Upload-Offset': '5',
          'Tus-Resumable': '1.0.0',
        },
      }))

    try {
      const uploadUrl = `http://localhost/build/upload/${jobId}/${jobUploadResource}`
      const apikey = { user_id: 'user-test', key: 'api-test' } as any
      const firstPatchResponse = await tusProxy(fakeContext(uploadUrl, 'PATCH') as any, jobId, apikey)
      const headResponse = await tusProxy(fakeContext(uploadUrl, 'HEAD') as any, jobId, apikey, 'HEAD')
      const secondPatchResponse = await tusProxy(fakeContext(uploadUrl, 'PATCH') as any, jobId, apikey)
      const forwardedMethods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)
      const [, headInit] = fetchMock.mock.calls[1] as [string, RequestInit]

      expect(firstPatchResponse.status).toBe(204)
      expect(firstPatchResponse.headers.get('Upload-Offset')).toBe('4')
      expect(headResponse.status).toBe(200)
      expect(headResponse.headers.get('Upload-Offset')).toBe('4')
      expect(secondPatchResponse.status).toBe(204)
      expect(secondPatchResponse.headers.get('Upload-Offset')).toBe('5')
      expect(forwardedMethods).toEqual(['PATCH', 'HEAD', 'PATCH'])
      expect(headInit).not.toHaveProperty('body')
      expect(headInit).not.toHaveProperty('duplex')
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('forwards HEAD probes to builder without a request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 204,
      headers: {
        'Upload-Offset': '5',
        'Tus-Resumable': '1.0.0',
      },
    }))

    try {
      const context = fakeContext(`http://localhost/build/upload/${jobId}/${jobUploadResource}`, 'HEAD')
      const response = await tusProxy(context as any, jobId, { user_id: 'user-test', key: 'api-test' } as any, 'HEAD')
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]

      expect(response.status).toBe(204)
      expect(response.headers.get('Upload-Offset')).toBe('5')
      expect(init.method).toBe('HEAD')
      expect(init).not.toHaveProperty('body')
      expect(init).not.toHaveProperty('duplex')
    }
    finally {
      fetchMock.mockRestore()
    }
  })

  it('rejects PATCH to a different TUS suffix than this job upload_path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    let error: HTTPException | undefined
    try {
      await tusProxy(
        fakeContext(`http://localhost/build/upload/${jobId}/other-job-id`, 'PATCH') as any,
        jobId,
        { user_id: 'user-test', key: 'api-test' } as any,
      )
    }
    catch (err) {
      expect(err).toBeInstanceOf(HTTPException)
      if (!(err instanceof HTTPException)) {
        throw err
      }
      error = err
    }
    finally {
      const forwardedUrls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(forwardedUrls.some(url => url.includes('/upload/other-job-id'))).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockRestore()
    }

    if (!error) {
      throw new Error('Expected tusProxy to reject with HTTPException')
    }
    expect(error.status).toBe(400)
    expect(error.cause).toMatchObject({
      error: 'invalid_path',
      message: 'Upload path does not match this build request',
    })
  })

  it('rejects expired upload_expires_at before forwarding', async () => {
    queryBuilder = createQueryBuilder({
      ...defaultBuildRequest,
      upload_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    })
    mockSupabaseApikey.mockReturnValue({
      from: vi.fn().mockReturnValue(queryBuilder),
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    let error: HTTPException | undefined
    try {
      await tusProxy(
        fakeContext(`http://localhost/build/upload/${jobId}/${jobUploadResource}`, 'PATCH') as any,
        jobId,
        { user_id: 'user-test', key: 'api-test' } as any,
      )
    }
    catch (err) {
      expect(err).toBeInstanceOf(HTTPException)
      if (!(err instanceof HTTPException)) {
        throw err
      }
      error = err
    }
    finally {
      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockRestore()
    }

    if (!error) {
      throw new Error('Expected tusProxy to reject with HTTPException')
    }
    expect(error.status).toBe(403)
    expect(error.cause).toMatchObject({
      error: 'upload_expired',
      message: 'Upload window has expired',
    })
  })

  it('rejects non-pending terminal status before forwarding', async () => {
    queryBuilder = createQueryBuilder({
      ...defaultBuildRequest,
      status: 'failed',
    })
    mockSupabaseApikey.mockReturnValue({
      from: vi.fn().mockReturnValue(queryBuilder),
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    let error: HTTPException | undefined
    try {
      await tusProxy(
        fakeContext(`http://localhost/build/upload/${jobId}/${jobUploadResource}`, 'PATCH') as any,
        jobId,
        { user_id: 'user-test', key: 'api-test' } as any,
      )
    }
    catch (err) {
      expect(err).toBeInstanceOf(HTTPException)
      if (!(err instanceof HTTPException)) {
        throw err
      }
      error = err
    }
    finally {
      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockRestore()
    }

    if (!error) {
      throw new Error('Expected tusProxy to reject with HTTPException')
    }
    expect(error.status).toBe(403)
    expect(error.cause).toMatchObject({
      error: 'upload_not_allowed',
      message: 'Upload is not allowed for this build status',
    })
  })

  it('forwards valid POST without extra suffix to builder upload root', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 201,
      headers: {
        Location: 'https://builder.capgo.app/upload/file.zip',
      },
    }))

    try {
      const context = fakeContext(`http://localhost/build/upload/${jobId}`, 'POST')
      const response = await tusProxy(context as any, jobId, { user_id: 'user-test', key: 'api-test' } as any)

      expect(response.status).toBe(201)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://builder.capgo.app/upload/',
        expect.anything(),
      )
    }
    finally {
      fetchMock.mockRestore()
    }
  })
})
