import type { Context } from 'hono'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono/tiny'
import { describe, expect, it, vi } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { z } from 'zod'
import { getDatabaseURL, getEUReadReplicaDatabaseURL } from '../supabase/functions/_backend/utils/pg.ts'

async function route(env: Record<string, unknown>, run: (c: Context) => void) {
  const app = new Hono()
  app.get('/', (c) => {
    run(c)
    return c.json({ status: 'ok' })
  })
  expect((await app.request('/', {}, env)).status).toBe(200)
}

describe('EU snapshot source binding', () => {
  it('ignores regional and primary bindings when selecting the EU source', async () => route({
    HYPERDRIVE_CAPGO_READ_PLUGIN_STATE_EU: { connectionString: 'postgresql://eu-replica' },
    HYPERDRIVE_CAPGO_READ_NA: { connectionString: 'postgresql://na-replica' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgresql://primary' },
  }, c => expect(getEUReadReplicaDatabaseURL(c)).toBe('postgresql://eu-replica')))

  it('fails closed without EU even when primary and another regional replica are configured', async () => route({
    HYPERDRIVE_CAPGO_READ_NA: { connectionString: 'postgresql://na-replica' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgresql://primary' },
    MAIN_SUPABASE_DB_URL: 'postgresql://primary-pooler', SUPABASE_DB_URL: 'postgresql://primary-direct',
    LOCAL_READ_REPLICA_SUPABASE_DB_URL: 'postgresql://not-a-local-runtime', ENV_NAME: 'capgo_api-prod',
  }, c => expect(() => getEUReadReplicaDatabaseURL(c)).toThrow('EU read replica is required')))

  it('does not reroute unrelated API read helpers through the publisher binding', async () => route({
    HYPERDRIVE_CAPGO_READ_PLUGIN_STATE_EU: { connectionString: 'postgresql://eu-replica' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgresql://primary' },
  }, c => {
    expect(getEUReadReplicaDatabaseURL(c)).toBe('postgresql://eu-replica')
    expect(getDatabaseURL(c, true)).toBe('postgresql://primary')
  }))

  it('allows only an explicit local replica URL in a local runtime', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', 'postgresql://test-replica')
    try {
    await route({ ENV_NAME: 'capgo_api-local', LOCAL_READ_REPLICA_SUPABASE_DB_URL: 'postgresql://test-replica' },
      c => expect(getEUReadReplicaDatabaseURL(c)).toBe('postgresql://test-replica'))
    vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', '')
    await route({ ENV_NAME: 'capgo_api-local', SUPABASE_DB_URL: 'postgresql://primary' },
      c => expect(() => getEUReadReplicaDatabaseURL(c)).toThrow('EU read replica is required'))
    } finally { vi.unstubAllEnvs() }
  })

  it('shares the existing EU read binding in API prod/alpha and leaves preprod primary unbound', () => {
    const config = (worker: string, env: string) => z.array(z.object({ binding: z.string(), id: z.string() })).parse(unstable_readConfig({ config: fileURLToPath(new URL(`../cloudflare_workers/${worker}/wrangler.jsonc`, import.meta.url)), env }).hyperdrive)
    const replica = config('plugin', 'prod_eu').find(binding => binding.binding === 'HYPERDRIVE_CAPGO_READ_EU')
    expect(replica?.id).toBeTruthy()
    for (const env of ['prod', 'alpha']) {
      const bindings = config('api', env)
      const source = bindings.find(binding => binding.binding === 'HYPERDRIVE_CAPGO_READ_PLUGIN_STATE_EU')
      expect(source?.id).toBe(replica?.id)
      expect(source?.id).not.toBe(bindings.find(binding => binding.binding === 'HYPERDRIVE_CAPGO_DIRECT_EU')?.id)
    }
    expect(config('api', 'preprod').some(binding => binding.binding === 'HYPERDRIVE_CAPGO_READ_PLUGIN_STATE_EU')).toBe(false)
  })
})
