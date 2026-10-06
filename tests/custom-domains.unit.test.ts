import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudflareCustomHostname, customDomainConfig, customDomainInstructions, hostnameSchema } from '../supabase/functions/_backend/utils/custom-domains.ts'

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => ({
    CF_ANALYTICS_TOKEN: 'test-token',
  } as Record<string, string>)[key] ?? '',
}))

const zoneResponse = () => new Response(JSON.stringify({ success: true, result: [{ id: 'a'.repeat(32), name: 'capgo.app' }] }))

const context = { get: vi.fn() } as unknown as Context
afterEach(() => vi.unstubAllGlobals())

describe('custom Live Updates domains', () => {
  it('reuses the existing token and SaaS CNAME target', () => {
    expect(customDomainConfig(context)).toEqual({ token: 'test-token', target: 'plugin.capgo.app' })
  })

  it.concurrent.each(['https://updates.example.com', '*.example.com', 'example.com/path', 'localhost', '127.0.0.1', 'plugin.capgo.app', 'capgo.app', '-bad.example.com'])('rejects %s', (hostname) => {
    expect(hostnameSchema.safeParse(hostname).success).toBe(false)
  })

  it.concurrent('normalizes a hostname and exposes DNS verification records', () => {
    expect(hostnameSchema.parse(' Updates.Example.com ')).toBe('updates.example.com')
    const instructions = customDomainInstructions({
      id: 'provider-id',
      hostname: 'updates.example.com',
      status: 'pending',
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.updates.example.com', value: 'ownership-token' },
      ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme-challenge.updates.example.com', txt_value: 'certificate-token' }] },
    }, 'customers.capgo.app')
    expect(instructions.dns_records).toHaveLength(3)
    expect(instructions.endpoints).toBeNull()
  })

  it.concurrent.each([['active', 'pending'], ['pending', 'active'], ['active', 'active']])('requires hostname %s and TLS %s', (status, sslStatus) => {
    const instructions = customDomainInstructions({ id: 'provider-id', hostname: 'updates.example.com', status, ssl: { status: sslStatus } }, 'customers.capgo.app')
    expect(instructions.status).toBe(status === 'active' && sslStatus === 'active' ? 'active' : 'pending')
    if (instructions.status === 'active')
      expect(instructions.endpoints?.channelUrl).toBe('https://updates.example.com/channel_self')
  })

  it('creates a DNS-validated TLS hostname through the configured zone', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(zoneResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: 'provider-id', hostname: 'updates.example.com' } })))
    vi.stubGlobal('fetch', fetchMock)
    await cloudflareCustomHostname(context, 'POST', '', 'updates.example.com')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/zones?name=capgo.app&status=active')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token')
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.cloudflare.com/client/v4/zones/${'a'.repeat(32)}/custom_hostnames`)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ hostname: 'updates.example.com', ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } })
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('does not expose provider errors and tolerates an already-deleted domain', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(zoneResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ success: false, errors: [{ message: 'private provider details' }] }), { status: 403 })).mockResolvedValueOnce(zoneResponse()).mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cloudflareCustomHostname(context, 'GET', 'provider-id')).rejects.toThrow('Unable to update the custom domain')
    await expect(cloudflareCustomHostname(context, 'DELETE', 'provider-id')).resolves.toBeNull()
  })

  it('does not provision a hostname when the existing token cannot read the zone', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cloudflareCustomHostname(context, 'POST', '', 'updates.example.com')).rejects.toThrow('Unable to access the custom domain zone')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['zone', 'hostname'].flatMap(stage => ['', '<html>Unavailable</html>'].map(body => ({ stage, body }))))('maps malformed $stage responses to the provider 502', async ({ stage, body }) => {
    const fetchMock = vi.fn()
    if (stage === 'hostname')
      fetchMock.mockResolvedValueOnce(zoneResponse())
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cloudflareCustomHostname(context, 'GET', 'provider-id')).rejects.toMatchObject({
      status: 502,
      cause: { error: 'custom_domain_provider_error' },
    })
  })
})
