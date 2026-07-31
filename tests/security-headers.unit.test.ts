import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import pluginWorker from '../cloudflare_workers/plugin/index.ts'
import { API_CONTENT_SECURITY_POLICY, createAllCatch, createHono, getAllowedCorsOrigin, useCors } from '../supabase/functions/_backend/utils/hono.ts'

const consoleHeaders = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')

describe('security response headers', () => {
  it.concurrent('declares a CSP for the console app static responses', () => {
    expect(consoleHeaders).toContain('Content-Security-Policy: default-src \'self\'')
    expect(consoleHeaders).toContain('script-src \'self\' \'unsafe-inline\' https://challenges.cloudflare.com https://static.cloudflareinsights.com https://psthg.capgo.app')
    expect(consoleHeaders).toContain('style-src \'self\' \'unsafe-inline\' https://fonts.bunny.net')
    expect(consoleHeaders).toContain('frame-src \'self\' https://challenges.cloudflare.com')
    expect(consoleHeaders).toContain('frame-ancestors \'none\'')
    expect(consoleHeaders).toContain('connect-src \'self\' blob: https: wss:')
  })

  it.concurrent.each([
    ['api', apiWorker, 'https://api.preprod.capgo.app/ok', 200],
    ['plugin', pluginWorker, 'https://plugin.preprod.capgo.app/ok', 200],
  ] as const)('sets the API CSP on %s worker responses', async (_name, worker, url, status) => {
    const response = await worker.fetch(new Request(url))

    expect(response.status).toBe(status)
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
  })

  it.concurrent('sets the API CSP on files worker fallback responses', async () => {
    const app = createHono('files', 'test')
    createAllCatch(app, 'files')
    const response = await app.fetch(new Request('https://files.preprod.capgo.app/'))

    expect(response.status).toBe(404)
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
  })

  it.concurrent.each([
    'https://123-com-example-app.preview.preprod.capgo.app/',
    'https://123-com-example-app.preview.preprod.capgo.app:8443/',
  ])('does not apply the API CSP to preview subdomain %s', async (url) => {
    const app = createHono('files', 'test')
    app.get('/', c => c.html('<!DOCTYPE html><html><body>preview</body></html>'))

    const response = await app.fetch(new Request(url))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBeNull()
  })

  it.concurrent.each([
    'https://capgo.app',
    'https://preprod.capgo.app',
    'https://development.capgo.app',
    'https://console.capgo.app',
    'https://console.preprod.capgo.app',
    'capacitor://localhost',
    'ionic://localhost',
    'localhost://localhost',
    'https://localhost',
    'http://localhost:5173',
  ])('allows trusted CORS origin %s without using wildcard', async (origin) => {
    const app = createHono('api', 'test')
    app.use('/cors-test', useCors)
    app.get('/cors-test', c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('https://api.preprod.capgo.app/cors-test', {
      headers: { origin },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  })

  it('allows the runtime WEBAPP_URL CORS origin', () => {
    vi.stubEnv('WEBAPP_URL', 'https://console.selfhost.example')
    try {
      expect(getAllowedCorsOrigin('https://console.selfhost.example', {} as Parameters<typeof getAllowedCorsOrigin>[1])).toBe('https://console.selfhost.example')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('allows runtime CORS_ALLOWED_ORIGINS custom native origins', () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'myapp://localhost')
    try {
      expect(getAllowedCorsOrigin('myapp://localhost', {} as Parameters<typeof getAllowedCorsOrigin>[1])).toBe('myapp://localhost')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.concurrent('does not emit wildcard CORS for untrusted origins', async () => {
    const app = createHono('api', 'test')
    app.use('/cors-test', useCors)
    app.get('/cors-test', c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('https://api.preprod.capgo.app/cors-test', {
      headers: { origin: 'https://evil.example' },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.concurrent('does not emit wildcard CORS on rejected preflight requests', async () => {
    const app = createHono('api', 'test')
    app.use('/cors-test', useCors)
    app.get('/cors-test', c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('https://api.preprod.capgo.app/cors-test', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://evil.example',
        'access-control-request-method': 'GET',
      },
    }))

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
  })
})
