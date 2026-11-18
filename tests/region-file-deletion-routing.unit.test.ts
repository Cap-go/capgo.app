import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parseJsonc } from '../scripts/generate-plugin-route-hosts.ts'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app as files } from '../supabase/functions/_backend/files/files.ts'
import { buildFileReadCacheRequest } from '../supabase/functions/_backend/files/file_read_cache.ts'
import { resetReplicationLagMemory, setReplicationLagMemoryEntry } from '../supabase/functions/_backend/plugin_runtime/utils/replicaFreshness.ts'
import { SERVING_REGIONS } from '../supabase/functions/_backend/plugin_runtime/utils/servingRegions.ts'

const fixture = vi.hoisted(() => ({
  epoch: 'test-deletion-routing' as string | null,
  deleted: true,
  outage: false,
  clients: [] as { connectionString: string }[],
  queries: [] as { text: string, values: unknown[] | undefined }[],
}))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ get servingRegionReaderEpoch() { return fixture.epoch } }))
vi.mock('hono/adapter', async (original) => ({
  ...await original<typeof import('hono/adapter')>(), getRuntimeKey: () => 'workerd', env: (c: { env: unknown }) => c.env,
}))
// Only the network driver is replaced. Policy admission, getPgClient,
// getDatabaseURL, replica selection and deletion/cache handlers are real.
vi.mock('pg', () => {
  class Client {
    constructor(config: { connectionString: string }) { fixture.clients.push(config) }
    on() { return this }
    async connect() {}
    async end() {}
    async query(text: string, values?: unknown[]) {
      fixture.queries.push({ text, values })
      if (fixture.outage)
        throw Object.assign(new Error('Synthetic transient database outage'), { code: 'ECONNRESET' })
      return { rows: text.includes('SELECT deleted, deleted_at') && fixture.deleted ? [{ deleted: true, deleted_at: null }] : [] }
    }
  }
  return { Client, Pool: Client, default: { Client, Pool: Client } }
})
vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({ sendDiscordAlert: vi.fn(), sendDiscordAlert500: vi.fn() }))
const appId = 'com.example.deleted'
const key = `orgs/example/apps/${appId}/bundle.zip`
const cacheEntries = new Map<string, Response>()
const cache = {
  match: vi.fn(async (req: Request) => cacheEntries.get(req.url)?.clone()),
  put: vi.fn(async (req: Request, response: Response) => { cacheEntries.set(req.url, response) }),
}
const app = new Hono().route('/files', files)
function request() {
  const req = new Request(`https://files.example.com/files/read/attachments/${key}`)
  Object.defineProperty(req, 'cf', { value: { colo: 'EWR' } })
  return req
}
function environment(regions: readonly string[] = ['NA']) {
  const put = vi.fn()
  const env = {
    ENV_NAME: 'capgo_files-prod',
    PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, app_id: appId, generation: '1', policy: { regions, mode: 'route' } }) }) },
    HYPERDRIVE_CAPGO_READ_NA: { connectionString: 'postgres://replica-na' },
    HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://replica-eu' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://forbidden-primary' },
    ATTACHMENT_BUCKET: { put, head: vi.fn(async () => null), get: vi.fn() },
  }
  return { env, put }
}
async function serve(env: ReturnType<typeof environment>['env']) {
  const pending: Promise<unknown>[] = []
  const res = await app.fetch(request(), env, { props: {}, waitUntil: promise => pending.push(promise), passThroughOnException() {} })
  await Promise.all(pending)
  return res
}
beforeEach(() => {
  fixture.epoch = 'test-deletion-routing'
  fixture.deleted = true
  fixture.outage = false
  fixture.clients.length = 0
  fixture.queries.length = 0
  cacheEntries.clear()
  vi.clearAllMocks()
  vi.stubGlobal('caches', { default: cache })
  cacheEntries.set(buildFileReadCacheRequest(request()).url, new Response('cached zip bytes', { headers: { 'content-type': 'application/zip' } }))
})
afterEach(() => { vi.unstubAllGlobals(); resetReplicationLagMemory() })

describe('regional deleted zip evidence through the real routing helper', () => {
  it('keeps deleted cached zips at 404 when enabling a subset policy', async () => {
    const { env, put } = environment()
    fixture.epoch = null
    expect((await serve(env)).status).toBe(404)
    fixture.clients.length = 0
    fixture.queries.length = 0
    fixture.epoch = 'test-deletion-routing'
    expect((await serve(env)).status).toBe(404)
    expect(fixture.clients.map(client => client.connectionString)).toEqual(['postgres://replica-na'])
    expect(fixture.queries).toEqual([{ text: expect.stringContaining('SELECT deleted, deleted_at'), values: [key] }])
    expect(put).not.toHaveBeenCalled()
  })
  it('reads an allowed replica without transactions or primary fallback when every region is selected', async () => {
    const { env, put } = environment(SERVING_REGIONS)
    expect((await serve(env)).status).toBe(404)
    expect(fixture.clients.map(client => client.connectionString)).toEqual(['postgres://replica-eu'])
    expect(fixture.queries).toHaveLength(1)
    expect(fixture.queries[0]?.text).toContain('SELECT deleted, deleted_at')
    expect(fixture.queries[0]?.text).not.toMatch(/BEGIN|now\(|transaction_timestamp/i)
    expect(put).not.toHaveBeenCalled()
  })
  it.each([false, true])('preserves live cache bytes and R2 restoration on a real transient outage: %s', async (outage) => {
    fixture.deleted = false
    fixture.outage = outage
    const { env, put } = environment()
    const response = await serve(env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('cached zip bytes')
    expect(fixture.clients.map(client => client.connectionString)).toEqual(['postgres://replica-na'])
    expect(fixture.queries).toHaveLength(1)
    expect(put).toHaveBeenCalledOnce()
    expect(put.mock.calls[0]?.[0]).toBe(key)
  })
  it('does not turn missing allowed replicas into a permissive deleted-zip result', async () => {
    const { env, put } = environment()
    const { HYPERDRIVE_CAPGO_READ_NA: _na, ...noAllowed } = env
    expect((await app.fetch(request(), noAllowed)).status).toBe(503)
    expect(fixture.clients).toEqual([])
    expect(put).not.toHaveBeenCalled()
  })
  it('does not select an excluded EU binding when the only allowed replica is lagging', async () => {
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_NA', { status: 'lagging', max_lag_seconds: 2400 })
    const { env, put } = environment()
    expect((await serve(env)).status).toBe(503)
    expect(fixture.clients).toEqual([])
    expect(put).not.toHaveBeenCalled()
  })
  it('prepares every production replica binding from the existing plugin source configuration', () => {
    const bindings = z.object({ hyperdrive: z.array(z.object({ binding: z.string(), id: z.string() })) })
    const fileConfig = z.object({ env: z.object({ prod: bindings }) }).parse(parseJsonc(readFileSync(new URL('../cloudflare_workers/files/wrangler.jsonc', import.meta.url), 'utf8')))
    const pluginConfig = z.object({ env: z.object({ prod_eu: bindings }) }).parse(parseJsonc(readFileSync(new URL('../cloudflare_workers/plugin/wrangler.jsonc', import.meta.url), 'utf8')))
    const reads = fileConfig.env.prod.hyperdrive.filter(binding => binding.binding.startsWith('HYPERDRIVE_CAPGO_READ_'))
    expect(reads).toHaveLength(SERVING_REGIONS.length)
    expect(reads).toEqual(pluginConfig.env.prod_eu.hyperdrive)
    const primary = fileConfig.env.prod.hyperdrive.find(binding => binding.binding === 'HYPERDRIVE_CAPGO_DIRECT_EU')
    expect(reads.every(binding => binding.id !== primary?.id)).toBe(true)
  })
  it('binds the alpha files worker to the replicas of the alpha plugin worker, and never relabels the preprod primary', () => {
    const bindings = z.object({ hyperdrive: z.array(z.object({ binding: z.string(), id: z.string() })).default([]) })
    const environments = z.object({ env: z.object({ preprod: bindings, alpha: bindings }) })
    const fileConfig = environments.parse(parseJsonc(readFileSync(new URL('../cloudflare_workers/files/wrangler.jsonc', import.meta.url), 'utf8')))
    const pluginConfig = environments.parse(parseJsonc(readFileSync(new URL('../cloudflare_workers/plugin/wrangler.jsonc', import.meta.url), 'utf8')))
    const reads = (env: { hyperdrive: { binding: string }[] }) => env.hyperdrive.filter(binding => binding.binding.startsWith('HYPERDRIVE_CAPGO_READ_'))
    expect(reads(fileConfig.env.alpha)).toEqual(pluginConfig.env.alpha.hyperdrive)
    // Preproduction has no replica: its direct binding is the primary.
    expect(reads(fileConfig.env.preprod)).toEqual([])
  })
})
