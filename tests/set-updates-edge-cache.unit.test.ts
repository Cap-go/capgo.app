import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseJsonc, WRANGLER_PATH } from '../scripts/generate-plugin-route-hosts.ts'
import { normalizeEdgeCacheValue, pluginEnvs, resolveTargetEnvs } from '../scripts/set-updates-edge-cache.ts'

describe('updates-edge-cache:set', () => {
  it('normalizes the rollout value', () => {
    expect(normalizeEdgeCacheValue('ON')).toBe('on')
    expect(normalizeEdgeCacheValue('off')).toBe('off')
    expect(normalizeEdgeCacheValue('1%')).toBe('1%')
    expect(normalizeEdgeCacheValue('0.5')).toBe('0.5%')
    expect(normalizeEdgeCacheValue('0')).toBe('off')
    expect(normalizeEdgeCacheValue('100%')).toBe('on')
    expect(normalizeEdgeCacheValue('250%')).toBeNull()
    expect(normalizeEdgeCacheValue('yes')).toBeNull()
  })

  it('targets every prod plugin env by default and rejects unknown envs', () => {
    const envs = pluginEnvs(parseJsonc(readFileSync(WRANGLER_PATH, 'utf8')))
    const prod = resolveTargetEnvs([], envs)
    expect(prod.length).toBeGreaterThan(0)
    expect(prod.every(env => env.startsWith('prod_'))).toBe(true)
    expect(resolveTargetEnvs(['preprod'], envs)).toEqual(['preprod'])
    expect(() => resolveTargetEnvs(['prod_nope'], envs)).toThrow('Unknown plugin env')
  })

  it('leaves UPDATES_EDGE_CACHE out of wrangler vars (a var would block the secret)', () => {
    expect(readFileSync(WRANGLER_PATH, 'utf8')).not.toMatch(/"UPDATES_EDGE_CACHE"\s*:/)
  })
})
