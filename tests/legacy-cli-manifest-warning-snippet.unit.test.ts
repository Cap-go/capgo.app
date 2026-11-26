import { afterEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/legacy_cli_manifest_warning/index.js'

const WARNINGS_URL = 'https://sb.capgo.app/rest/v1/rpc/get_organization_cli_warnings'
const MARKER = 'x-capgo-snippet'

function stubOrigin(response: Response | object) {
  const origin = vi.fn(async () => response)
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
    const request = new Request('https://sb.capgo.app/functions/v1/bundle', { method: 'PUT', body: '{}' })

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

  it('returns WebSocket upgrade responses untouched', async () => {
    const upgrade = { status: 101, headers: new Headers({ upgrade: 'websocket' }) }
    stubOrigin(upgrade)

    const response = await snippet.fetch(new Request('https://sb.capgo.app/realtime/v1/websocket'))

    expect(response).toBe(upgrade)
    expect(upgrade.headers.get(MARKER)).toBeNull()
  })
})
