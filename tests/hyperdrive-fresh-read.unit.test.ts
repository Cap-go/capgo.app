import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bypassHyperdriveCache, freshQueryArgs, inFreshReads, withFreshReads } from '../supabase/functions/_backend/plugin_runtime/utils/hyperdriveFreshRead.ts'
import { getCachedAppOwner } from '../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts'

function makeContext() {
  const raw = new Request('https://plugin.capgo.test/updates', { method: 'POST' })
  return {
    env: {},
    req: { url: raw.url, raw, header: () => undefined },
    res: { headers: new Headers() },
    get: () => undefined,
    set: () => {},
    header: () => {},
  } as any
}

describe('hyperdrive fresh reads', () => {
  it('adds an unused now() CTE to SELECT and WITH queries only', () => {
    expect(bypassHyperdriveCache('select "id" from "apps" where "app_id" = $1'))
      .toBe('WITH capgo_fresh_read AS (SELECT now()) select "id" from "apps" where "app_id" = $1')
    expect(bypassHyperdriveCache('  with "a" as (select 1) select * from "a"'))
      .toBe('WITH capgo_fresh_read AS (SELECT now()), "a" as (select 1) select * from "a"')
    expect(bypassHyperdriveCache('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t'))
      .toBe('WITH RECURSIVE capgo_fresh_read AS (SELECT now()), t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t')
    expect(bypassHyperdriveCache('update "apps" set "name" = $1')).toBe('update "apps" set "name" = $1')
    expect(bypassHyperdriveCache('selected')).toBe('selected')
  })

  it('rewrites pg query arguments only inside withFreshReads', async () => {
    const config = { text: 'select 1', values: [], rowMode: 'array' }
    expect(freshQueryArgs([config])).toEqual([config])
    await withFreshReads(async () => {
      expect(freshQueryArgs([config, 'cb'])).toEqual([{ ...config, text: 'WITH capgo_fresh_read AS (SELECT now()) select 1' }, 'cb'])
      expect(freshQueryArgs(['select 2', [1]])).toEqual(['WITH capgo_fresh_read AS (SELECT now()) select 2', [1]])
      // A named prepared statement keeps its text.
      const named = { name: 'stmt', text: 'select 3' }
      expect(freshQueryArgs([named])).toEqual([named])
    })
    expect(inFreshReads()).toBe(false)
  })
})

describe('edge cache refills', () => {
  beforeEach(() => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'mock-token')
    const store = new Map<string, Response>()
    const cache = {
      match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
      put: vi.fn(async (request: Request, response: Response) => {
        store.set(request.url, response.clone())
      }),
      delete: vi.fn(async (request: Request) => store.delete(request.url)),
    }
    vi.stubGlobal('caches', { default: cache, open: vi.fn().mockResolvedValue(cache) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('run their loader past the Hyperdrive query cache', async () => {
    const seen: boolean[] = []
    const load = vi.fn(async () => {
      await Promise.resolve()
      seen.push(inFreshReads())
      return { owner_org: 'org-1', plan_valid: true }
    })
    await getCachedAppOwner(makeContext(), 'com.example.app', 'mau', load)
    expect(seen).toEqual([true])
    expect(inFreshReads()).toBe(false)
  })
})
