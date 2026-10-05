import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler'

const WORKERS = ['api', 'files', 'plugin', 'translation'] as const

function configPath(worker: string) {
  return fileURLToPath(new URL(`../cloudflare_workers/${worker}/wrangler.jsonc`, import.meta.url))
}

function deployedEnvs(worker: string) {
  const { rawConfig } = experimental_readRawConfig({ config: configPath(worker) })
  // `local` only runs under wrangler dev; every other env is deployed to Cloudflare.
  return Object.keys(rawConfig.env ?? {}).filter(env => env !== 'local')
}

describe('wrangler observability', () => {
  it.each(WORKERS)('enables Workers Issues on every deployed %s env', (worker) => {
    const envs = deployedEnvs(worker)
    expect(envs.length).toBeGreaterThan(0)

    for (const env of envs) {
      const config = unstable_readConfig({ config: configPath(worker), env })
      // Issues groups uncaught exceptions, 5xx and console.error output so
      // production failures surface without tailing each worker by hand.
      expect(config.observability, `${worker}:${env}`).toMatchObject({
        enabled: true,
        issues: { enabled: true },
      })
    }
  })
})
