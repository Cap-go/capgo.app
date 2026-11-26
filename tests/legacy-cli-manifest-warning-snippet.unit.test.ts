import { afterEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/legacy_cli_manifest_warning/index.js'

const WARNINGS_URL = 'https://sb.capgo.app/rest/v1/rpc/get_organization_cli_warnings'
const MARKER = 'x-capgo-snippet'

function stubOrigin(response: Response | object) {
  const origin = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', origin)
  return origin
}

function warningsRequest(cliVersion: string) {
  return new Request(WARNINGS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgid: 'org', cli_version: cliVersion }),
  })
}

describe('legacy_cli_manifest_warning snippet marker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks passthrough responses and keeps status, headers and body', async () => {
    const origin = stubOrigin(new Response('bundle-body', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/plain', 'x-origin': 'supabase' },
    }))
    const request = new Request('https://sb.capgo.app/functions/v1/channel', { method: 'POST', body: '{}' })

    const response = await snippet.fetch(request)

    expect(origin).toHaveBeenCalledWith(request)
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-origin')).toBe('supabase')
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(await response.text()).toBe('bundle-body')
  })

  it('marks error responses from the origin', async () => {
    stubOrigin(new Response('{"message":"no"}', { status: 401 }))

    const response = await snippet.fetch(new Request('https://sb.capgo.app/rest/v1/apps'))

    expect(response.status).toBe(401)
    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(await response.text()).toBe('{"message":"no"}')
  })

  it('still injects the legacy manifest warning for old CLIs, with the marker', async () => {
    stubOrigin(Response.json([{ code: 'other', message: 'Update CLI', fatal: false }]))

    const response = await snippet.fetch(warningsRequest('7.12.0'))
    const warnings = await response.json() as Array<{ code: string }>

    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(warnings.map(warning => warning.code)).toEqual(['other', 'legacy_manifest_upload'])
  })

  it('leaves warnings for current CLIs unchanged apart from the marker', async () => {
    stubOrigin(Response.json([{ code: 'other', message: 'Update CLI', fatal: false }]))

    const response = await snippet.fetch(warningsRequest('8.30.0'))
    const warnings = await response.json() as Array<{ code: string }>

    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(warnings.map(warning => warning.code)).toEqual(['other'])
  })

  it.each([
    ['PUT', '/functions/v1/bundle', 'https://api.capgo.app/bundle'],
    ['DELETE', '/functions/v1/bundle/ai_bump_level?x=1', 'https://api.capgo.app/bundle/ai_bump_level?x=1'],
    ['POST', '/functions/v1/private/set_manifest', 'https://api.capgo.app/private/set_manifest'],
    ['POST', '/functions/v1/files/upload_link', 'https://files.capgo.app/files/upload_link'],
    ['PATCH', '/functions/v1/files/upload/attachments/abc', 'https://files.capgo.app/files/upload/attachments/abc'],
  ])('forwards old-CLI %s %s to the Cloudflare backend', async (method, path, target) => {
    const origin = stubOrigin(Response.json({ status: 'success' }, { status: 200 }))
    const request = new Request(`https://sb.capgo.app${path}`, {
      method,
      headers: { 'authorization': 'Bearer anon', 'capgkey': 'key', 'content-type': 'application/json' },
      body: '{"app_id":"com.test.app"}',
    })

    const response = await snippet.fetch(request)

    expect(origin).toHaveBeenCalledTimes(1)
    const forwarded = origin.mock.calls[0][0] as Request
    expect(forwarded.url).toBe(target)
    expect(forwarded.method).toBe(method)
    expect(forwarded.headers.get('authorization')).toBe('Bearer anon')
    expect(forwarded.headers.get('capgkey')).toBe('key')
    expect(await forwarded.text()).toBe('{"app_id":"com.test.app"}')
    expect(response.status).toBe(200)
    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(await response.json()).toEqual({ status: 'success' })
  })

  it('rejects old-CLI private/upload_link in the snippet without forwarding', async () => {
    const origin = stubOrigin(new Response('should not be called'))

    const response = await snippet.fetch(new Request('https://sb.capgo.app/functions/v1/private/upload_link', { method: 'POST', body: '{}' }))

    expect(origin).not.toHaveBeenCalled()
    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get(MARKER)).toBe('legacy')
    expect(await response.json()).toMatchObject({ error: 'legacy_cli_unsupported' })
  })

  it.each([
    'https://sb.capgo.app/functions/v1/channel',
    'https://sb.capgo.app/functions/v1/bundles',
    'https://sb.capgo.app/functions/v1/private/delete_failed_version',
    'https://sb.capgo.app/functions/v1/files',
    'https://other.capgo.app/functions/v1/bundle',
  ])('passes %s through unchanged', async (url) => {
    const origin = stubOrigin(new Response('origin'))
    const request = new Request(url, { method: 'POST', body: '{}' })

    const response = await snippet.fetch(request)

    expect(origin).toHaveBeenCalledWith(request)
    expect(await response.text()).toBe('origin')
  })

  it('returns WebSocket upgrade responses untouched', async () => {
    const upgrade = { status: 101, headers: new Headers({ upgrade: 'websocket' }) }
    stubOrigin(upgrade)

    const response = await snippet.fetch(new Request('https://sb.capgo.app/realtime/v1/websocket'))

    expect(response).toBe(upgrade)
    expect(upgrade.headers.get(MARKER)).toBeNull()
  })
})
