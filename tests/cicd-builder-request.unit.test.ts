import type { Context, Next } from 'hono'
import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app as buildApp } from '../supabase/functions/_backend/public/build/index.ts'

const { requestBuild, query } = vi.hoisted(() => ({
  requestBuild: vi.fn(),
  query: vi.fn(),
}))

// Build submission is stubbed; endpoint routing, parsing and CI detection are real.
vi.mock('../supabase/functions/_backend/public/build/request.ts', () => ({ requestBuild }))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (c: Context, next: Next) => {
    c.set('apikey', { key: 'test-build-key', user_id: 'test-user', rbac_id: '00000000-0000-0000-0000-000000000001' })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: async () => ({ query }),
  closeClient: vi.fn(),
}))

const routes = new Hono().basePath('/build').route('/', buildApp)
const appId = 'com.example.cicd.builder'

beforeEach(() => {
  requestBuild.mockReset()
  query.mockReset()
  query.mockResolvedValue({ rows: [{ recorded: true }] })
})

async function request() {
  return routes.request('/build/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cli-ci': 'GitHub Actions' },
    body: JSON.stringify({ app_id: appId, platform: 'android' }),
  })
}

describe('Builder CI detection through the request endpoint', () => {
  it('records Builder evidence after a successful request', async () => {
    requestBuild.mockImplementation(async (c: Context) => c.json({ job_id: 'test-job', status: 'pending' }))
    const response = await request()
    expect(response.status).toBe(200)
    expect(query).toHaveBeenCalledWith(
      'SELECT public.record_app_cicd_deploy($1, $2, $3::uuid, $4) AS recorded',
      [appId, 'builder', '00000000-0000-0000-0000-000000000001', 'GitHub Actions'],
    )
  })

  it('does not record rejected Builder requests', async () => {
    requestBuild.mockImplementation(async (c: Context) => c.json({ error: 'service_unavailable' }, 503))
    const response = await request()
    expect(response.status).toBe(503)
    expect(query).not.toHaveBeenCalled()
  })
})
