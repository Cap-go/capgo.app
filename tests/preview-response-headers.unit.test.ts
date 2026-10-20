import { describe, expect, it } from 'vitest'
import { PREVIEW_X_ROBOTS_TAG } from '../supabase/functions/_backend/files/preview-host-headers.ts'
import { buildPreviewDownloadPayload, buildPreviewResponseHeaders, buildPreviewRobotsTxtResponse, handlePreviewSubdomain } from '../supabase/functions/_backend/files/preview.ts'
import { createAllCatch, createHono } from '../supabase/functions/_backend/utils/hono.ts'

describe('preview response headers', () => {
  it.concurrent('keeps bundle preview responses immutable', () => {
    const headers = buildPreviewResponseHeaders('text/html', {
      httpEtag: '"bundle-etag"',
    })

    expect(headers.get('content-type')).toBe('text/html')
    expect(headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(headers.get('etag')).toBe('"bundle-etag"')
    expect(headers.get('pragma')).toBeNull()
    expect(headers.get('expires')).toBeNull()
    expect(headers.get('x-robots-tag')).toBe(PREVIEW_X_ROBOTS_TAG)
  })

  it.concurrent('disables caching for channel preview responses', () => {
    const headers = buildPreviewResponseHeaders('text/html', {
      disableCache: true,
      httpEtag: '"channel-etag"',
    })

    expect(headers.get('content-type')).toBe('text/html')
    expect(headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate, max-age=0')
    expect(headers.get('etag')).toBeNull()
    expect(headers.get('pragma')).toBe('no-cache')
    expect(headers.get('expires')).toBe('0')
    expect(headers.get('x-robots-tag')).toBe(PREVIEW_X_ROBOTS_TAG)
  })

  it.concurrent('serves robots.txt that disallows all crawlers on preview hosts', () => {
    const response = buildPreviewRobotsTxtResponse()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-robots-tag')).toBe(PREVIEW_X_ROBOTS_TAG)
    return expect(response.text()).resolves.toBe('User-agent: *\nDisallow: /\n')
  })

  it.concurrent('adds X-Robots-Tag to preview subdomain errors and skips other hosts', async () => {
    const app = createHono('files', 'test')
    app.use('/*', async (c, next) => {
      const hostname = c.req.header('host') || ''
      if (/\.preview(?:\.[^.]+)?\.capgo\.app$/.test(hostname))
        return handlePreviewSubdomain(c)
      return next()
    })
    app.get('/ok', c => c.json({ status: 'ok' }))
    createAllCatch(app, 'files')

    const previewError = await app.fetch(new Request('https://invalid.preview.capgo.app/index.html', {
      headers: { host: 'invalid.preview.capgo.app' },
    }))
    expect(previewError.headers.get('x-robots-tag')).toBe(PREVIEW_X_ROBOTS_TAG)
    expect(previewError.status).toBeGreaterThanOrEqual(400)

    const previewRobots = await app.fetch(new Request('https://invalid.preview.capgo.app/robots.txt', {
      headers: { host: 'invalid.preview.capgo.app' },
    }))
    expect(previewRobots.headers.get('x-robots-tag')).toBe(PREVIEW_X_ROBOTS_TAG)
    await expect(previewRobots.text()).resolves.toBe('User-agent: *\nDisallow: /\n')

    const apiOk = await app.fetch(new Request('https://api.capgo.app/ok'))
    expect(apiOk.headers.get('x-robots-tag')).toBeNull()
  })

  it.concurrent('builds a direct updater payload from an external bundle URL', async () => {
    await expect(buildPreviewDownloadPayload({} as never, 'com.example.app', {
      checksum: 'abc123',
      external_url: 'https://example.com/app.zip',
      id: 42,
      manifest_count: 3,
      name: '1.0.0',
      r2_path: null,
      session_key: null,
    })).resolves.toEqual({
      appId: 'com.example.app',
      checksum: 'abc123',
      sessionKey: undefined,
      url: 'https://example.com/app.zip',
      version: '1.0.0',
    })
  })

  it.concurrent('rejects encrypted bundles instead of returning a zip download payload', async () => {
    await expect(buildPreviewDownloadPayload({} as never, 'com.example.app', {
      checksum: 'a'.repeat(512),
      external_url: 'https://example.com/app.zip',
      id: 42,
      manifest_count: 3,
      name: '1.0.0',
      r2_path: null,
      session_key: 'iv:encrypted-session-key',
    })).rejects.toMatchObject({
      message: 'Encrypted bundles cannot be previewed. Upload an unencrypted bundle to use Capgo preview.',
    })
  })
})
