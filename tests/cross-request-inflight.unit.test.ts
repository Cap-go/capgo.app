import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidIpInfo as pluginInvalidIpInfo } from '../supabase/functions/_backend/plugin_runtime/utils/invalids_ip.ts'
import { setReplicationLagHeader as pluginSetReplicationLagHeader } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { invalidIpInfo } from '../supabase/functions/_backend/utils/invalids_ip.ts'
import { setReplicationLagHeader } from '../supabase/functions/_backend/utils/pg.ts'

vi.mock('hono/adapter', async importOriginal => ({
  ...await importOriginal<typeof import('hono/adapter')>(),
  getRuntimeKey: () => 'workerd',
}))

// Workers cannot settle a promise for request B when its I/O belongs to
// request A: once A finishes, B hangs until the runtime cancels it ("code had
// hung"). In-flight dedup must therefore never cross request contexts.

function requestContext(requestId: string, databaseSource = 'replica') {
  return {
    req: { url: 'https://plugin.capgo.test/stats', header: () => undefined, raw: new Request('https://plugin.capgo.test/stats') },
    res: new Response(null),
    get: (key: string) => key === 'requestId' ? requestId : key === 'databaseSource' ? databaseSource : undefined,
    header: () => {},
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => {}) },
  } as any
}

function deferredIpApiFetch() {
  const pending: Array<() => void> = []
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
    pending.push(() => resolve(new Response(JSON.stringify({ status: 'success', isp: 'Home ISP', org: '', as: 'AS3215 Home', asname: '', proxy: false, hosting: false }))))
  }))
  return { fetchMock, releaseAll: () => pending.splice(0).forEach(release => release()) }
}

describe('cross-request in-flight dedup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['plugin runtime', pluginInvalidIpInfo],
    ['api', invalidIpInfo],
  ])('%s IP lookups only share in-flight work inside one request', async (_name, lookup) => {
    vi.stubGlobal('caches', undefined)
    const { fetchMock, releaseAll } = deferredIpApiFetch()
    vi.stubGlobal('fetch', fetchMock)
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`
    const requestA = requestContext('request-a')
    const requestB = requestContext('request-b')

    const results = [lookup(ip, requestA), lookup(ip, requestA), lookup(ip, requestB)]
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    releaseAll()

    await expect(Promise.all(results)).resolves.toEqual([
      { blocked: false, provider: null },
      { blocked: false, provider: null },
      { blocked: false, provider: null },
    ])
  })

  it.each([
    ['plugin runtime', pluginSetReplicationLagHeader],
    ['api', setReplicationLagHeader],
  ])('%s replication lag probes are never awaited across requests', async (_name, setHeader) => {
    vi.stubGlobal('caches', undefined)
    const source = `replica-inflight-${crypto.randomUUID()}`
    const pendingQueries: Array<() => void> = []
    const pool = {
      query: vi.fn(() => new Promise((resolve) => {
        pendingQueries.push(() => resolve({ rows: [{ lag_seconds: '1' }] }))
      })),
    }

    const first = setHeader(requestContext('request-a', source), pool as any)
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1))
    const second = setHeader(requestContext('request-b', source), pool as any)
    // Request B runs its own probe instead of awaiting request A's query.
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(2))
    pendingQueries.splice(0).forEach(release => release())
    await Promise.all([first, second])
  })
})
