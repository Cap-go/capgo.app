import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_DOMAINS_SQL, includeCustomDomains, loadProductionCustomDomains, MAX_CUSTOM_DOMAINS } from '../scripts/snippet/custom-domains'

const token = 'test-token'

describe('production domain inventory', () => {
  it.concurrent('uses one bounded, read-only SQL query and returns validated hostnames', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
      expect(JSON.parse(init!.body as string)).toEqual({ query: CUSTOM_DOMAINS_SQL, read_only: true })
      expect(CUSTOM_DOMAINS_SQL).toContain('FROM public.org_custom_domains ORDER BY hostname LIMIT 1001')
      expect(init?.redirect).toBe('error')
      return Response.json([{ domains: [{ hostname: 'updates.example.com', provisioned: true }] }])
    })
    expect(await loadProductionCustomDomains({ token, fetcher })).toEqual(['updates.example.com'])
    expect(fetcher.mock.calls[0][0]).toBe('https://api.supabase.com/v1/projects/xvwzpoazmxkqosrdewyv/database/query')
  })

  it.concurrent('accepts an empty inventory without removing existing routes', async () => {
    const fetcher = async () => Response.json([{ domains: [] }])
    expect(await loadProductionCustomDomains({ token, fetcher })).toEqual([])
  })

  it.concurrent.each([
    { label: 'truncated response', data: [] },
    { label: 'provider error', data: { error: 'private data' } },
    { label: 'missing rows', data: [{}] },
    { label: 'incomplete registration', data: [{ domains: [{ hostname: 'updates.example.com', provisioned: false }] }] },
    { label: 'too many rows', data: [{ domains: Array.from({ length: MAX_CUSTOM_DOMAINS + 1 }, (_, i) => ({ hostname: `host${i}.example.com`, provisioned: true })) }] },
  ])('rejects $label', async ({ data }) => {
    await expect(loadProductionCustomDomains({ token, fetcher: async () => Response.json(data) })).rejects.toThrow()
  })

  it.concurrent('sanitizes provider and parsing errors', async () => {
    await expect(loadProductionCustomDomains({ token, fetcher: async () => new Response('private data', { status: 403 }) })).rejects.toThrow('query failed (HTTP 403)')
    await expect(loadProductionCustomDomains({ token, fetcher: async () => new Response('private data') })).rejects.toThrow('Invalid production custom-domain response')
    await expect(loadProductionCustomDomains({ token, fetcher: async () => { throw new Error('private data') } })).rejects.toThrow('Unable to read production custom domains')
  })

  it.concurrent('requires production credentials before making requests', async () => {
    const fetcher = vi.fn()
    await expect(loadProductionCustomDomains({ token: '', fetcher })).rejects.toThrow('SUPABASE_ACCESS_TOKEN')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('custom-domain snippet expression', () => {
  const host = 'updates.example.com'
  const equality = `http.host eq "${host}"`

  it.concurrent('preserves manual domains and path predicates and is idempotent', () => {
    const base = '(http.host eq "legacy.example.net") or (http.request.full_uri wildcard r"*api.capgo.app/updates*")'
    const next = includeCustomDomains(base, [host, host])
    expect(next.added).toBe(1)
    expect(next.expression).toBe(`(${base}) or (${equality})`)
    expect(includeCustomDomains(next.expression, [host])).toEqual({ expression: next.expression, added: 0 })
    expect(includeCustomDomains(next.expression, [])).toEqual({ expression: next.expression, added: 0 })
  })

  it.concurrent.each([equality, `(${equality})`, `((${equality}) or (http.host eq "plugin.capgo.app"))`])('recognizes an unconditional host alternative', (expression) => {
    expect(includeCustomDomains(expression, [host])).toEqual({ expression, added: 0 })
  })

  it.concurrent.each([
    `not (${equality})`,
    `(${equality} and http.request.uri.path eq "/stats")`,
    `(${equality}) and http.request.uri.path eq "/stats"`,
    `http.request.uri.path eq "(${equality.replaceAll('"', '\\"')}) or other"`,
    `http.request.uri.path eq r#"(${equality}) or other"#`,
  ])('does not confuse a conditional or quoted hostname with full coverage', (expression) => {
    expect(includeCustomDomains(expression, [host]).added).toBe(1)
  })

  it.concurrent.each(['*.example.com', 'https://updates.example.com', 'UPDATES.example.com', 'x" or true', 'capgo.app', 'test.capgo.app', '-bad.example.com'])('rejects invalid input %s', (hostname) => {
    expect(() => includeCustomDomains(equality, [hostname])).toThrow('invalid hostname')
  })

  it.concurrent.each(['(', 'http.host eq "unterminated'])('fails on malformed live expressions', (expression) => {
    expect(() => includeCustomDomains(expression, [host])).toThrow('Cannot safely parse')
  })
})
