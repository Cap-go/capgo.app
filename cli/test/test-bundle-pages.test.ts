import { describe, expect, it } from 'bun:test'
import { getActiveAppVersions } from '../src/api/versions.ts'

function makeBundleRow(index: number) {
  return {
    id: index,
    name: `1.0.${index}`,
    app_id: 'com.test.app',
    created_at: '2024-01-01T00:00:00.000Z',
    deleted: false,
  }
}

function makeCannotGetBundleError(message = 'Cannot get bundle', status = 400) {
  const response = new Response(JSON.stringify({ error: 'cannot_get_bundle', message }), { status })
  return Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: response })
}

function makeCannotAccessAppError() {
  const response = new Response(JSON.stringify({ error: 'cannot_get_bundle', message: 'You can\'t access this app' }), { status: 403 })
  return Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: response })
}

function createInvokeStub(handlers: Record<number, () => Promise<{ data: unknown, error: Error | null }>>) {
  return async (path: string) => {
    const url = new URL(path, 'https://example.test/')
    const page = Number(url.searchParams.get('page') || '0')
    const handler = handlers[page]
    if (!handler)
      throw new Error(`unexpected bundle page ${page}`)
    return handler()
  }
}

describe('fetchBundlePages empty-list EOF', () => {
  it('returns [] when page 0 responds with cannot_get_bundle', async () => {
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: null, error: makeCannotGetBundleError() }),
      }),
    })
    expect(versions).toEqual([])
  })

  it('returns accumulated bundles when a later page responds with cannot_get_bundle', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeBundleRow(index))
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({ data: null, error: makeCannotGetBundleError() }),
      }),
    })
    expect(versions).toHaveLength(50)
    expect(versions[0]?.name).toBe('1.0.0')
    expect(versions[49]?.name).toBe('1.0.49')
  })

  it('throws a permission message when cannot_get_bundle means access denied', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeBundleRow(index))
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({ data: null, error: makeCannotAccessAppError() }),
      }),
    })).rejects.toThrow(/Cannot list bundles/)
  })

  it('throws a service error message for unrelated failures on later pages', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeBundleRow(index))
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({ data: null, error: makeCannotGetBundleError('Database unavailable', 503) }),
      }),
    })).rejects.toThrow(/Could not list bundles/)
  })
})
