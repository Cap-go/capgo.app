import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudflareCustomHostname, customDomainInstructions, hostnameSchema } from '../supabase/functions/_backend/utils/custom-domains.ts'

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_context: unknown, key: string) => ({
    CF_CUSTOM_DOMAINS_TOKEN: 'test-token',
    CF_CUSTOM_DOMAINS_ZONE_ID: 'a'.repeat(32),
    CF_CUSTOM_DOMAINS_CNAME_TARGET: 'customers.capgo.app',
  } as Record<string, string>)[key] ?? '',
}))

const context = { get: vi.fn() } as unknown as Context
afterEach(() => vi.unstubAllGlobals())

describe('custom Live Updates domains', () => {
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, result: { id: 'provider-id', hostname: 'updates.example.com' } })))
    vi.stubGlobal('fetch', fetchMock)
    await cloudflareCustomHostname(context, 'POST', '', 'updates.example.com')
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.cloudflare.com/client/v4/zones/${'a'.repeat(32)}/custom_hostnames`)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ hostname: 'updates.example.com', ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } })
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('does not expose provider errors and tolerates an already-deleted domain', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: false, errors: [{ message: 'private provider details' }] }), { status: 403 })).mockResolvedValueOnce(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cloudflareCustomHostname(context, 'GET', 'provider-id')).rejects.toThrow('Unable to update the custom domain')
    await expect(cloudflareCustomHostname(context, 'DELETE', 'provider-id')).resolves.toBeNull()
  })
})
