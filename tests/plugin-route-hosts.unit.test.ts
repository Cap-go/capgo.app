import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectPluginRouteHosts, GENERATED_PATH, parseJsonc, renderGenerated, WRANGLER_PATH } from '../scripts/generate-plugin-route-hosts.ts'
import { isPluginZone } from '../supabase/functions/_backend/triggers/updates_cache_purge.ts'

describe('plugin route hosts', () => {
  it('is generated from the current plugin wrangler routes (run bun run generate:plugin-route-hosts)', () => {
    const config = parseJsonc(readFileSync(WRANGLER_PATH, 'utf8'))
    expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(renderGenerated(config))
  })

  it('parses jsonc comments and trailing commas without touching strings', () => {
    expect(parseJsonc('{\n  // comment\n  "a": "x//y", /* block */ "b": [1, 2,],\n}')).toEqual({ a: 'x//y', b: [1, 2] })
    // Commas inside strings are values, not trailing commas.
    expect(parseJsonc('{"value": "a, }", "list": ["b, ]",],}')).toEqual({ value: 'a, }', list: ['b, ]'] })
    expect(collectPluginRouteHosts({ env: { prod: { routes: [{ pattern: 'api.example.com/updates*', zone_name: 'example.com' }, { pattern: 'plugin.example.net' }] } } }))
      .toEqual({ hosts: ['api.example.com', 'plugin.example.net'], zoneNames: ['example.com'] })
  })

  it('selects only zones the plugin worker is routed on', () => {
    expect(isPluginZone('capgo.app')).toBe(true)
    // No plugin route on usecapgo.com any more: never purged.
    expect(isPluginZone('usecapgo.com')).toBe(false)
    expect(isPluginZone('Capgo.App')).toBe(true)
    expect(isPluginZone('capgo.io')).toBe(false)
    expect(isPluginZone('example.com')).toBe(false)
  })
})
