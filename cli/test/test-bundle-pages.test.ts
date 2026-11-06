import { describe, expect, it } from 'bun:test'
import { getActiveAppVersions } from '../src/api/versions.ts'
import { CliUserError } from '../src/shared/cli-user-error.ts'

function makeBundleRow(index: number) {
  return {
    id: index,
    name: `1.0.${index}`,
    app_id: 'com.test.app',
    created_at: '2024-01-01T00:00:00.000Z',
    deleted: false,
  }
}

// What a backend without `fields=summary` support returns: full rows.
function makeLegacyBundleRow(index: number) {
  return { ...makeBundleRow(index), native_packages: null, manifest: null }
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

  it('asks for 1000-row summary pages and stops after a short page', async () => {
    const paths: string[] = []
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: (async (path: string) => {
        paths.push(path)
        return { data: Array.from({ length: 690 }, (_, index) => makeBundleRow(index)), error: null }
      }) as any,
    })
    expect(versions).toHaveLength(690)
    expect(paths).toHaveLength(1)
    const url = new URL(paths[0], 'https://example.test/')
    expect(url.searchParams.get('limit')).toBe('1000')
    expect(url.searchParams.get('fields')).toBe('summary')
  })

  it('keeps paging while the server returns full 1000-row pages', async () => {
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: Array.from({ length: 1000 }, (_, index) => makeBundleRow(index)), error: null }),
        1: async () => ({ data: [makeBundleRow(1000)], error: null }),
      }),
    })
    expect(versions).toHaveLength(1001)
  })

  it('makes a single request when a modern backend returns exactly 50 summary rows', async () => {
    let requests = 0
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: (async () => {
        requests += 1
        return { data: Array.from({ length: 50 }, (_, index) => makeBundleRow(index)), error: null }
      }) as any,
    })
    expect(versions).toHaveLength(50)
    expect(requests).toBe(1)
  })

  it('stops paging when a page returns fewer than 50 bundles (backend without limit support)', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeLegacyBundleRow(index))
    const secondPage = [makeLegacyBundleRow(50)]
    const versions = await getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({ data: secondPage, error: null }),
      }),
    })
    expect(versions).toHaveLength(51)
  })

  it('throws a permission message when cannot_get_bundle means access denied', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeLegacyBundleRow(index))
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({
          data: null,
          error: makeBundleApiError({ error: 'cannot_get_bundle', message: 'You can\'t access this app' }, 403),
        }),
      }),
    })).rejects.toThrow(/Cannot list bundles/)
  })

  it('throws when the API returns 500 for a database failure', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => makeLegacyBundleRow(index))
    await expect(getActiveAppVersions('test-key', 'com.test.app', {
      invoke: createInvokeStub({
        0: async () => ({ data: firstPage, error: null }),
        1: async () => ({
          data: null,
          error: makeBundleApiError({ error: 'cannot_get_bundle', message: 'Cannot get bundle' }, 500),
        }),
      }),
    })).rejects.toThrow(/Could not list bundles for app com\.test\.app: cannot_get_bundle \| Cannot get bundle/)
  })

  it('throws CliUserError with upstream cause when the API returns 403', async () => {
    const upstream = makeBundleApiError({ error: 'cannot_get_bundle', message: 'Access denied' }, 403)
    try {
      await getActiveAppVersions('test-key', 'com.test.app', {
        invoke: createInvokeStub({
          0: async () => ({ data: null, error: upstream }),
        }),
      })
      throw new Error('expected rejection')
    }
    catch (error) {
      expect(error).toBeInstanceOf(CliUserError)
      expect((error as CliUserError).cause).toBe(upstream)
      expect((error as Error).message).toMatch(/lacks the required permission/)
    }
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
