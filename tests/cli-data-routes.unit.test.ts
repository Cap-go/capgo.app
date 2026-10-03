import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/cli/index.ts'

interface QueryCall {
  table: string
  ops: [string, ...unknown[]][]
}

const mocks = vi.hoisted(() => ({
  calls: [] as QueryCall[],
  result: { data: null as unknown, error: null as unknown },
  rpc: vi.fn(),
  apikey: {
    id: 42,
    key: 'test-api-key',
    user_id: '11111111-1111-4111-8111-111111111111',
  },
}))

function createQuery(table: string) {
  const call: QueryCall = { table, ops: [] }
  mocks.calls.push(call)
  const query: Record<string, unknown> = {}
  for (const op of ['select', 'eq', 'in', 'or', 'order', 'limit', 'range', 'update', 'insert']) {
    query[op] = (...args: unknown[]) => {
      call.ops.push([op, ...args])
      return query
    }
  }
  query.maybeSingle = async () => mocks.result
  query.single = async () => mocks.result
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(mocks.result).then(resolve, reject)
  return query
}

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (c: any, next: () => Promise<void>) => {
    c.set('apikey', mocks.apikey)
    c.set('capgkey', mocks.apikey.key)
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({
    rpc: mocks.rpc,
    from: (table: string) => createQuery(table),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.calls.length = 0
  mocks.result = { data: null, error: null }
  mocks.rpc.mockResolvedValue({ data: mocks.apikey.user_id, error: null })
})

describe('private/cli data routes', () => {
  it('GET /channels filters by app and optional name with linked versions', async () => {
    mocks.result = { data: [{ id: 1, name: 'production', version_info: { id: 7, name: '1.0.0', deleted: false } }], error: null }
    const response = await app.request('http://local/channels?app_id=com.example.app&name=production')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 1, name: 'production', version_info: { id: 7, name: '1.0.0', deleted: false } }])
    expect(mocks.calls[0].table).toBe('channels')
    const select = mocks.calls[0].ops.find(([op]) => op === 'select')?.[1]
    expect(select).toContain('version_info:app_versions!channels_version_fkey')
    expect(select).toContain('rollout_version_info:app_versions!channels_rollout_version_fkey')
    expect(mocks.calls[0].ops).toContainEqual(['eq', 'app_id', 'com.example.app'])
    expect(mocks.calls[0].ops).toContainEqual(['eq', 'name', 'production'])
    expect(mocks.calls[0].ops).toContainEqual(['range', 0, 999])
  })

  it('GET /channels filters channels linked to a version', async () => {
    mocks.result = { data: [], error: null }
    const response = await app.request('http://local/channels?app_id=com.example.app&linked_version_id=7')
    expect(response.status).toBe(200)
    expect(mocks.calls[0].ops).toContainEqual(['or', 'version.eq.7,rollout_version.eq.7'])
  })

  it('GET /channels pages past the PostgREST row cap', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, name: `c${index}` }))
    let call = 0
    mocks.result = { data: null, error: null }
    const pages = [fullPage, [{ id: 1001, name: 'last' }]]
    const original = mocks.result
    Object.defineProperty(mocks, 'result', {
      configurable: true,
      get: () => ({ data: pages[Math.min(call++, pages.length - 1)], error: null }),
      set: () => {},
    })
    try {
      const response = await app.request('http://local/channels?app_id=com.example.app')
      expect((await response.json() as unknown[]).length).toBe(1001)
      expect(mocks.calls.map(entry => entry.ops.find(([op]) => op === 'range'))).toEqual([['range', 0, 999], ['range', 1000, 1999]])
    }
    finally {
      Object.defineProperty(mocks, 'result', { configurable: true, writable: true, enumerable: true, value: original })
    }
  })

  it('GET /channels rejects a missing app_id', async () => {
    const response = await app.request('http://local/channels')
    expect(response.status).toBe(400)
  })

  it('GET /apps/visible reports visibility', async () => {
    mocks.result = { data: { app_id: 'com.example.app', owner_org: '22222222-2222-4222-8222-222222222222' }, error: null }
    const visible = await app.request('http://local/apps/visible?app_id=com.example.app')
    expect(await visible.json()).toEqual({ visible: true, app_id: 'com.example.app', owner_org: '22222222-2222-4222-8222-222222222222' })

    mocks.result = { data: null, error: null }
    const hidden = await app.request('http://local/apps/visible?app_id=com.example.app')
    expect(await hidden.json()).toEqual({ visible: false, app_id: null, owner_org: null })
  })

  it('GET /bundles/latest includes deleted bundles', async () => {
    mocks.result = { data: { id: 9, name: '2.0.0', deleted: true, created_at: '2026-01-01' }, error: null }
    const response = await app.request('http://local/bundles/latest?app_id=com.example.app')
    expect(response.status).toBe(200)
    expect((await response.json() as { name: string }).name).toBe('2.0.0')
    expect(mocks.calls[0].ops.some(([op, column]) => op === 'eq' && column === 'deleted')).toBe(false)
  })

  it('POST /bundles/deleted soft-deletes only live bundles', async () => {
    mocks.result = { data: [{ name: '1.0.0' }], error: null }
    const response = await app.request('http://local/bundles/deleted', {
      method: 'POST',
      body: JSON.stringify({ app_id: 'com.example.app', names: ['1.0.0'], deleted: true }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ updated: ['1.0.0'] })
    expect(mocks.calls[0].ops).toContainEqual(['update', { deleted: true }])
    expect(mocks.calls[0].ops).toContainEqual(['eq', 'app_id', 'com.example.app'])
    expect(mocks.calls[0].ops).toContainEqual(['eq', 'deleted', false])
    expect(mocks.calls[0].ops).toContainEqual(['in', 'name', ['1.0.0']])
  })

  it('GET /manifest requires a numeric version id', async () => {
    const bad = await app.request('http://local/manifest?app_version_id=abc')
    expect(bad.status).toBe(400)

    mocks.result = { data: [{ file_name: 'index.html', file_hash: 'abc' }], error: null }
    const ok = await app.request('http://local/manifest?app_version_id=7')
    expect(await ok.json()).toEqual([{ file_name: 'index.html', file_hash: 'abc' }])
    expect(mocks.calls.at(-1)?.ops).toContainEqual(['eq', 'app_version_id', 7])
  })
})
