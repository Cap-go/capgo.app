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

function makeBundleApiError(payload: { error: string, message: string }, status: number) {
  const response = new Response(JSON.stringify(payload), { status })
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

describe('fetchBundlePages pagination', () => {
  it('returns [] when page 0 responds with an empty array', async () => {
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: [], error: null }),
      }),
    })
    expect(versions).toEqual([])
  })

  it('stops paging when a page returns fewer than 50 bundles', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeBundleRow(index))
    const secondPage = [makeBundleRow(50)]
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({ data: secondPage, error: null }),
      }),
    })
    expect(versions).toHaveLength(51)
  })

  it('throws when the API returns 500 for a database failure', async () => {
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({
          data: null,
          error: makeBundleApiError({ error: 'cannot_get_bundle', message: 'Cannot get bundle' }, 500),
        }),
      }),
    })).rejects.toThrow(/Could not list bundles for app com\.test\.app: cannot_get_bundle \| Cannot get bundle/)
  })

  it('throws when the API returns 404 app_not_found', async () => {
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({
          data: null,
          error: makeBundleApiError({ error: 'app_not_found', message: 'App not found' }, 404),
        }),
      }),
    })).rejects.toThrow(/App com\.test\.app not found in database/)
  })
})
