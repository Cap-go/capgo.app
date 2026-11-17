import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CUSTOM_DOMAIN_PLUGIN_EXPRESSION, includeCustomDomainRouting } from '../scripts/snippet/custom-domains'
import { deploySnippets } from '../scripts/snippet/deploy-snippets'

// Evaluate the actual emitted expression using only its documented Rules-language
// subset. Unknown tokens fail closed. This is a local semantic check, not the
// Cloudflare engine or provider-side validation.
function matches(expression: string, request: Request, rawHost = new URL(request.url).hostname): boolean {
  const url = new URL(request.url)
  const tokens = expression.match(/"(?:[^"\\]|\\.)*"|[a-z_][a-z0-9_.]*|[(){},]|\s+/gi) ?? []
  expect(tokens.join('')).toBe(expression)
  const mapping: Record<string, string> = {
    'http.host': 'host',
    'http.request.uri.path': 'path',
    'http.request.method': 'method',
    'http.request.full_uri': 'uri',
    'eq': '===',
    'ne': '!==',
    'and': '&&',
    'or': '||',
    'not': '!',
    'lower': 'lower',
    'ends_with': 'endsWith',
    'trim_end': 'trimEnd',
  }
  let js = tokens.map((token) => {
    if (token.startsWith('"') || /^[\s(){},]+$/.test(token) || token === 'in' || token === 'wildcard')
      return token
    if (!(token in mapping))
      throw new Error(`Unsupported test expression token: ${token}`)
    return mapping[token]
  }).join('')
  js = js.replace(/path in \{((?:"[^"\\]*"\s*)+)\}/g, '[$1].includes(path)')
  js = js.replace(/uri wildcard ("[^"]*")/g, 'wildcard(uri, $1)')
  // Rules inline sets separate strings with whitespace, unlike JS arrays.
  js = js.replace(/"\s+"/g, '","')
  return runInNewContext(js, {
    host: rawHost,
    uri: request.url,
    path: url.pathname,
    method: request.method,
    lower: (value: string) => value.toLowerCase(),
    trimEnd: (value: string, bytes: string) => {
      expect(bytes).toBe('.')
      return value.replace(/\.+$/, '')
    },
    wildcard: (value: string, pattern: string) => {
      const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${escaped}$`, 'i').test(value)
    },
    endsWith: (value: string, suffix: string) => value.endsWith(suffix),
  }) === true
}

const paths = [
  '/updates', '/stats', '/channel_self', '/updates/manifest_size',
  '/plugin/updates', '/plugin/stats', '/plugin/channel_self', '/plugin/updates/manifest_size',
]
const methods = ['POST', 'GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']
// Same native branch shape as the documented production routing, with a fake
// legacy hostname in place of private customer alternatives.
const baseline = '(http.host eq "plugin.capgo.app") or (http.host eq "plugin.usecapgo.com") or (http.host eq "legacy.example.net") or (http.request.full_uri wildcard "*api.capgo.app/updates*") or (http.request.full_uri wildcard "*api.capgo.app/plugin/*") or (http.request.full_uri wildcard "*api.capgo.app/stats") or (http.request.full_uri wildcard "*api.capgo.app/channel_self")'

describe('stable custom-domain snippet routing', () => {
  it.concurrent.each(paths)('routes every method for exact plugin path %s, including query strings', (path) => {
    for (const method of methods) {
      const request = new Request(`https://new-api.example.org${path}?app_id=com.example.fake`, { method })
      expect(matches(CUSTOM_DOMAIN_PLUGIN_EXPRESSION, request)).toBe(true)
    }
  })

  it.concurrent.each([
    'capgo.app', 'console.capgo.app', 'api.capgo.app', 'plugin.capgo.app',
    'plugin.eu.capgo.app', 'plugin.na.capgo.app', 'plugin.as.capgo.app', 'plugin.sa.capgo.app',
    'plugin.oc.capgo.app', 'plugin.af.capgo.app', 'plugin.me.capgo.app', 'plugin.hk.capgo.app',
    'plugin.jp.capgo.app', 'api.internal.capgo.app', 'files.capgo.app', 'plugin.dev.capgo.app',
    'workers.dev', 'fake-plugin.example.workers.dev', 'preview.fake-plugin.example.workers.dev',
    'CAPGO.APP', 'CONSOLE.CAPGO.APP', 'PLUGIN.EU.CAPGO.APP',
    'capgo.app.', 'console.capgo.app.', 'plugin.eu.capgo.app.',
    'workers.dev.', 'FAKE-PLUGIN.EXAMPLE.WORKERS.DEV.',
  ])('does not add routing for native or direct Worker host %s', (hostname) => {
    for (const path of paths)
      expect(matches(CUSTOM_DOMAIN_PLUGIN_EXPRESSION, new Request(`https://${hostname}${path}`), hostname)).toBe(false)
  })

  it.concurrent.each([
    '/', '/app', '/dashboard', '/org/custom_domains', '/private/custom_domains', '/triggers/queue',
    '/serving_policy/com.example.fake', '/cache_purge_local', '/__internal__/edge-v4/fake',
    '/files/read', '/auth/v1/token', '/ok', '/latency', '/plugin/ok', '/plugin/latency',
    '/api/stats', '/functions/v1/updates', '/updates_history', '/stats_extra', '/channel_selfish',
    '/updates/', '/stats/', '/channel_self/', '/updates/nested', '/stats/nested',
    '/updates/manifest_size/nested', '/plugin/updates/', '/plugin/stats/nested', '/plugin/channel_self/nested',
    '/plugin/updates/manifest_size/', '/UPDATES', '/%75pdates',
  ])('does not add routing for unrelated path %s', (path) => {
    for (const method of methods)
      expect(matches(CUSTOM_DOMAIN_PLUGIN_EXPRESSION, new Request(`https://new-api.example.org${path}`, { method }))).toBe(false)
  })

  it.concurrent('uses hostname boundaries rather than CNAME targets or substring matches', () => {
    for (const host of ['notcapgo.app', 'capgo.app.example.org', 'workers.dev.example.org'])
      expect(matches(CUSTOM_DOMAIN_PLUGIN_EXPRESSION, new Request(`https://${host}/updates`))).toBe(true)
  })

  it.concurrent('retains the complete original expression and is idempotent', () => {
    const next = includeCustomDomainRouting(baseline)
    expect(next).toEqual({ expression: `(${baseline}) or ${CUSTOM_DOMAIN_PLUGIN_EXPRESSION}`, changed: true })
    expect(includeCustomDomainRouting(next.expression)).toEqual({ expression: next.expression, changed: false })
    expect(includeCustomDomainRouting(`((${next.expression}))`).changed).toBe(false)
    for (const host of ['plugin.capgo.app', 'plugin.usecapgo.com', 'legacy.example.net', 'api.capgo.app', 'console.capgo.app']) {
      for (const path of [...paths, '/dashboard']) {
        const request = new Request(`https://${host}${path}`)
        expect(matches(next.expression, request)).toBe(matches(baseline, request))
      }
    }
  })

  it.concurrent.each([
    `not ${CUSTOM_DOMAIN_PLUGIN_EXPRESSION}`,
    `${CUSTOM_DOMAIN_PLUGIN_EXPRESSION} and http.request.method eq "POST"`,
    `http.request.uri.path eq ${JSON.stringify(CUSTOM_DOMAIN_PLUGIN_EXPRESSION)}`,
    `http.request.uri.path eq r#"${CUSTOM_DOMAIN_PLUGIN_EXPRESSION}"#`,
  ])('does not confuse conditional, negated or quoted occurrences with coverage', (expression) => {
    expect(includeCustomDomainRouting(expression).changed).toBe(true)
  })

  it.concurrent.each(['', '(', ')', 'http.host eq "unterminated'])('fails closed on malformed live expression %s', (expression) => {
    expect(() => includeCustomDomainRouting(expression)).toThrow('Cannot safely parse')
  })

  it.concurrent('enforces the provider expression limit, including on subsequent releases', () => {
    const prefix = 'http.host eq "example.org"'
    const room = 4096 - includeCustomDomainRouting(prefix).expression.length
    const atLimit = includeCustomDomainRouting(prefix + ' '.repeat(room)).expression
    expect(atLimit).toHaveLength(4096)
    expect(includeCustomDomainRouting(atLimit).changed).toBe(false)
    expect(() => includeCustomDomainRouting(prefix + ' '.repeat(room + 1))).toThrow('4096-character')
    expect(() => includeCustomDomainRouting(atLimit + ' ')).toThrow('4096-character')
  })

  it.concurrent('routes future and manual hostnames with one release write and no lifecycle rule writes', async () => {
    const code = 'export default {}\n'
    const definitions = [{ name: 'plugin_load_balancer', code }, { name: 'other', code }]
    let rules = [
      { snippet_name: 'plugin_load_balancer', expression: baseline, enabled: true, description: 'Existing plugin branches' },
      { snippet_name: 'other', expression: 'http.host eq "manual.example.org"', enabled: false, description: 'Manual rule' },
    ]
    const other = structuredClone(rules[1])
    const writes: string[] = []
    const logs: string[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.split('/snippets')[1]
      const ok = (result: unknown) => Response.json({ success: true, result })
      if (init?.method === 'PUT') {
        writes.push(path)
        expect(path).toBe('/snippet_rules')
        rules = JSON.parse(String(init.body)).rules
      }
      if (path === '') return ok(definitions.map(s => ({ snippet_name: s.name })))
      if (path === '/snippet_rules') return ok(rules)
      if (path.endsWith('/content')) {
        const form = new FormData()
        form.append('files', new File([code], 'snippet.js'))
        return new Response(form)
      }
      throw new Error('Unexpected provider call')
    }
    const run = () => deploySnippets({ token: 'fake-token', snippets: definitions, apply: true, fetcher, log: message => logs.push(message) })
    await run()
    expect(writes).toEqual(['/snippet_rules'])
    expect(rules[1]).toEqual(other)
    // These hosts were never supplied to the deployer or stored in a DB inventory.
    for (const host of ['new-api.example.org', 'manual-api.example.net', 'next-api.example.com']) {
      for (const path of paths)
        expect(matches(rules[0].expression, new Request(`https://${host}${path}`))).toBe(true)
    }
    await run()
    expect(writes).toEqual(['/snippet_rules'])
    expect(logs.join('\n')).not.toContain('legacy.example.net')
    expect(logs.join('\n')).not.toContain(baseline)
  })

  it.concurrent('release entrypoint has no production database inventory dependency', () => {
    const source = readFileSync('scripts/snippet/run-deployment.ts', 'utf8')
    expect(source).not.toMatch(/SUPABASE|customDomains|loadProductionCustomDomains/)
  })
})
