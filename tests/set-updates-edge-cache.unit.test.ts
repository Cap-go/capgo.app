import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseJsonc, WRANGLER_PATH } from '../scripts/generate-plugin-route-hosts.ts'
import { assertNoPluginStateBulkSettings, normalizeEdgeCacheValue, pluginEnvs, purgeSnippetEdgeAnswers, resolveSecretName, resolveTargetEnvs, SNIPPET_EDGE_ANSWERS_TAG } from '../scripts/set-updates-edge-cache.ts'

describe('updates-edge-cache:set', () => {
  it('sets the edge cache switch unless the snippet answers switch is named', () => {
    expect(resolveSecretName(['1%'])).toBe('UPDATES_EDGE_CACHE')
    expect(resolveSecretName(['--secret=SNIPPET_EDGE_ANSWER', '1%'])).toBe('SNIPPET_EDGE_ANSWER')
    expect(resolveSecretName(['--secret=PLUGIN_STATE_KV', '0.1%', 'prod_eu'])).toBe('PLUGIN_STATE_KV')
    expect(() => resolveSecretName(['--secret=JWT_SECRET'])).toThrow()
  })

  it('normalizes the rollout value', () => {
    expect(normalizeEdgeCacheValue('ON')).toBe('on')
    expect(normalizeEdgeCacheValue('off')).toBe('off')
    expect(normalizeEdgeCacheValue('1%')).toBe('1%')
    expect(normalizeEdgeCacheValue('0.5')).toBe('0.5%')
    expect(normalizeEdgeCacheValue('0')).toBe('off')
    expect(normalizeEdgeCacheValue('100%')).toBe('on')
    expect(normalizeEdgeCacheValue('250%')).toBeNull()
    // The worker works in 0.01% steps: refuse what it would round to 0.
    expect(normalizeEdgeCacheValue('0.004%')).toBeNull()
    expect(normalizeEdgeCacheValue('0.01%')).toBe('0.01%')
    expect(normalizeEdgeCacheValue('12.345%')).toBe('12.35%')
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

  it.each(['PLUGIN_STATE_KV', 'PLUGIN_STATE_TIMING'] as const)('requires explicit regional targets for %s', (secret) => {
    const envs = ['prod_eu', 'prod_na', 'preprod']
    expect(() => resolveTargetEnvs([], envs, secret)).toThrow('requires explicit')
    expect(resolveTargetEnvs(['prod_eu'], envs, secret)).toEqual(['prod_eu'])
    expect(() => resolveTargetEnvs(['prod_unknown'], envs, secret)).toThrow('Unknown plugin env')
  })

  it.each(['PLUGIN_STATE_KV', 'PLUGIN_STATE_KV_AUTHORITATIVE', 'PLUGIN_STATE_KV_STRICT', 'PLUGIN_STATE_TIMING'])('rejects %s from shared bulk uploads without exposing its value', (key) => {
    expect(() => assertNoPluginStateBulkSettings(`OTHER_SETTING=ok\nexport ${key}="on"`)).toThrow('must stay out of shared bulk env files')
    expect(() => assertNoPluginStateBulkSettings(`OTHER_SETTING=ok\n${key}=private-test-value`)).not.toThrow('private-test-value')
  })

  it('allows ordinary bulk settings and commented rollout examples', () => {
    expect(() => assertNoPluginStateBulkSettings('ORDINARY_SETTING=ok\n# PLUGIN_STATE_KV=on\n')).not.toThrow()
  })

  it('purges the stored snippet answers in every zone and reports failed zones', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => Response.json({ success: !String(url).includes('zone-b') }))
    expect(await purgeSnippetEdgeAnswers('token', ['zone-a', 'zone-b'], fetchImpl as unknown as typeof fetch)).toEqual(['zone-b'])
    expect(fetchImpl).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/zones/zone-a/purge_cache', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ tags: [SNIPPET_EDGE_ANSWERS_TAG] }),
    }))
  })
})
