import { describe, expect, it } from 'vitest'
import { buildPreviewDownloadPayload, buildPreviewResponseHeaders } from '../supabase/functions/_backend/files/preview.ts'

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
