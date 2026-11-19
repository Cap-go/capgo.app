import { describe, expect, it } from 'vitest'
import configs from '../configs.json'
import { servingPolicyStatusBaseUrl } from '../scripts/serving-policy-status-url'

describe('serving policy status environment', () => {
  it.each([
    ['prod', 'https://plugin.eu.capgo.app/serving_policy/'],
    ['preprod', 'https://plugin.preprod.capgo.app/serving_policy/'],
    ['development', 'https://plugin.dev.capgo.app/serving_policy/'],
    ['local', 'http://localhost:8788/serving_policy/'],
  ] as const)('uses the configured %s gateway', (environment, expected) => {
    expect(servingPolicyStatusBaseUrl(configs.plugin_region_targets[environment])).toBe(expected)
  })

  it('preserves an explicitly configured gateway base path', () => {
    expect(servingPolicyStatusBaseUrl(JSON.stringify([{ name: 'local', envName: 'test', url: 'https://gateway.example.com/plugins/ok?probe=1' }])))
      .toBe('https://gateway.example.com/plugins/serving_policy/')
  })

  it.each(['[]', '{}', 'null', '[{}]', '[{"name":"test","envName":"test","url":"not a URL"}]', '[{"name":"test","envName":"test","url":"ftp://example.com/ok"}]'])('rejects invalid gateway configuration %s', (targets) => {
    expect(() => servingPolicyStatusBaseUrl(targets)).toThrow()
  })
})
