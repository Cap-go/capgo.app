import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { resolveStorageEndpoint } from '../supabase/functions/_backend/utils/s3.ts'

async function resolveForRequest(env: Record<string, string>, headers: Record<string, string> = {}) {
  vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
  try {
    const app = new Hono<{ Bindings: Record<string, string> }>()
    app.get('/files/test', c => c.text(resolveStorageEndpoint(c)))

    const response = await app.request('http://127.0.0.1:12787/files/test', { headers }, env)
    return response.text()
  }
  finally {
    vi.unstubAllGlobals()
  }
}

describe('resolveStorageEndpoint', () => {
  it('keeps the configured local Storage host for Cloudflare Worker requests', async () => {
    const endpoint = await resolveForRequest({
      S3_ENDPOINT: 'http://127.0.0.1:58321/storage/v1/s3',
      S3_REWRITE_LOCAL_ENDPOINT: 'false',
    })

    expect(endpoint).toBe('http://127.0.0.1:58321/storage/v1/s3')
  })

  it('uses the forwarded host for the default local edge-function path', async () => {
    const endpoint = await resolveForRequest({
      S3_ENDPOINT: 'http://127.0.0.1:54321/storage/v1/s3',
    }, {
      'X-Forwarded-Host': 'kong',
      'X-Forwarded-Port': '8000',
      'X-Forwarded-Proto': 'http',
    })

    expect(endpoint).toBe('http://kong:8000/storage/v1/s3')
  })
})
