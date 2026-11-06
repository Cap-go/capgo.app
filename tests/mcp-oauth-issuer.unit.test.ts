import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('hosted MCP OAuth issuer', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_OAUTH_ISSUER', 'https://capgo.app/')
    vi.stubEnv('MCP_OAUTH_API_ORIGIN', 'https://api.capgo.app')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not serve issuer metadata at the API origin well-known URL (RFC 8414 §3.3)', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
      const response = await apiWorker.fetch(new Request(`https://api.capgo.app${path}`))
      expect(response.status).toBe(404)
    }
  })

  it('exposes metadata for the issuer origin with endpoints on the API origin', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp/oauth/metadata'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://capgo.app',
      authorization_endpoint: 'https://api.capgo.app/mcp/oauth/authorize',
      token_endpoint: 'https://api.capgo.app/mcp/oauth/token',
      registration_endpoint: 'https://api.capgo.app/mcp/oauth/register',
      revocation_endpoint: 'https://api.capgo.app/mcp/oauth/revoke',
    })
  })

  it('points protected resource metadata at the configured issuer', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/oauth-protected-resource/mcp'))
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://api.capgo.app/mcp',
      authorization_servers: ['https://capgo.app'],
    })
  })

  it('keeps the WWW-Authenticate challenge on the API origin', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource/mcp"')
  })

  it('advertises only api.capgo.app when reached through another hostname', async () => {
    const prm = await apiWorker.fetch(new Request('https://api.usecapgo.com/.well-known/oauth-protected-resource/mcp'))
    await expect(prm.json()).resolves.toMatchObject({
      resource: 'https://api.capgo.app/mcp',
      authorization_servers: ['https://capgo.app'],
    })
    const challenge = await apiWorker.fetch(new Request('https://api.usecapgo.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    }))
    expect(challenge.headers.get('www-authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource/mcp"')
    const metadata = await apiWorker.fetch(new Request('https://api.usecapgo.com/mcp/oauth/metadata'))
    await expect(metadata.json()).resolves.toMatchObject({ authorization_endpoint: 'https://api.capgo.app/mcp/oauth/authorize' })
  })
})
