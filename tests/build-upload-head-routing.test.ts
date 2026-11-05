import { Hono } from 'hono/tiny'
import { describe, expect, it } from 'vitest'
import { app as buildApp } from '../supabase/functions/_backend/public/build/index.ts'

const buildRoutes = new Hono().basePath('/build').route('/', buildApp)
const TUS = { 'Tus-Resumable': '1.0.0' }

// Intentionally uses a mounted Hono app as a lightweight routing smoke test:
// this validates the deployed /build/upload path before worker/binding setup.
describe('build upload HEAD routing', () => {
  it.concurrent.each([
    ['HEAD', '/test-job/file.zip', TUS],
    ['HEAD', '/test-job/file.zip', undefined],
    ['HEAD', '/test-job', TUS],
    // GET with Tus-Resumable is treated as a TUS HEAD fallback.
    ['GET', '/test-job/file.zip', TUS],
    ['GET', '/test-job', TUS],
  ] as const)('routes %s /build/upload%s (tus=%o) through auth middleware', async (method, path, headers) => {
    const response = await buildRoutes.request(new Request(`http://localhost/build/upload${path}`, { method, headers }))

    expect([400, 401]).toContain(response.status)
  })

  it.concurrent('keeps GET /build/upload/:jobId/* as not found', async () => {
    const response = await buildRoutes.request(new Request('http://localhost/build/upload/test-job/file.zip', { method: 'GET' }))

    expect(response.status).toBe(404)
  })
})
