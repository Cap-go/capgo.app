import type { Context } from 'hono'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/public/build/index.ts'

const mocks = vi.hoisted(() => ({ logs: vi.fn() }))
vi.mock('../supabase/functions/_backend/public/build/logs.ts', () => ({ streamBuildLogs: (...args: unknown[]) => mocks.logs(...args) }))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/hono_middleware.ts')>(),
  middlewareKey: () => async (c: Context, next: () => Promise<void>) => {
    c.set('apikey', { key: 'example-key', user_id: 'example-user' })
    await next()
  },
}))

beforeEach(() => mocks.logs.mockReset())
it('production log route forwards snapshot=true as a JSON read', async () => {
  mocks.logs.mockResolvedValue(Response.json({ logs: 'building', cursor: 1 }))
  const result = await app.request('http://local/logs/example-job?app_id=com.example.app&snapshot=true')
  expect(result.status).toBe(200)
  expect(result.headers.get('content-type')).toContain('application/json')
  expect(await result.json()).toMatchObject({ cursor: 1 })
  expect(mocks.logs).toHaveBeenCalledWith(expect.anything(), 'example-job', 'com.example.app', expect.objectContaining({ key: 'example-key' }), true)
})
it('production log route preserves legacy streaming without snapshot=true', async () => {
  mocks.logs.mockResolvedValue(new Response('data: building\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  const result = await app.request('http://local/logs/example-job?app_id=com.example.app')
  expect(result.headers.get('content-type')).toBe('text/event-stream')
  expect(mocks.logs.mock.calls[0][4]).toBe(false)
})
