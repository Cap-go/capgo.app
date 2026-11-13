import type { Unstable_Config } from 'wrangler'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { z } from 'zod'

const resourceConfig = z.object({
  hyperdrive: z.array(z.object({ binding: z.string(), id: z.string() })),
  analytics_engine_datasets: z.array(z.object({ binding: z.string(), dataset: z.string() })),
  r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() })),
})

function config(worker: string, env: string): Unstable_Config {
  return resourceConfig.parse(unstable_readConfig({
    config: fileURLToPath(new URL(`../cloudflare_workers/${worker}/wrangler.jsonc`, import.meta.url)),
    env,
  }))
}

describe('preprod resource isolation', () => {
  it.each(['api', 'files', 'plugin'])('keeps %s database connections and telemetry separate from production', (worker) => {
    const preprod = config(worker, 'preprod')
    const prod = config(worker, worker === 'plugin' ? 'prod_eu' : 'prod')
    const productionDatabases = new Set(prod.hyperdrive.map(binding => binding.id))
    const productionDatasets = new Set(prod.analytics_engine_datasets.map(binding => binding.dataset))

    expect(preprod.hyperdrive.length).toBeGreaterThan(0)
    for (const binding of preprod.hyperdrive)
      expect(productionDatabases.has(binding.id), binding.binding).toBe(false)
    for (const binding of preprod.analytics_engine_datasets)
      expect(productionDatasets.has(binding.dataset), binding.binding).toBe(false)
  })

  it('keeps uploaded dev bundles out of the production bucket', () => {
    const preprod = config('files', 'preprod').r2_buckets
    const productionBuckets = new Set(config('files', 'prod').r2_buckets.map(binding => binding.bucket_name))

    expect(preprod.length).toBeGreaterThan(0)
    for (const binding of preprod)
      expect(productionBuckets.has(binding.bucket_name), binding.binding).toBe(false)
  })
})
