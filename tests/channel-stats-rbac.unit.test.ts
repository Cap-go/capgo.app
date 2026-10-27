import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({ middlewareAuth: async (_c: unknown, next: () => Promise<void>) => next() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseWithAuth: () => ({ from: mocks.from }) }))

const { app } = await import('../supabase/functions/_backend/private/channel_stats.ts')
const { onError } = await import('../supabase/functions/_backend/utils/on_error.ts')
app.onError(onError('channel_stats'))

function request(body: Record<string, unknown>) {
  return app.request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('channel_stats channel-scoped RBAC', () => {
  beforeEach(() => {
    mocks.permission.mockReset()
    mocks.from.mockReset()
  })

  it('denies an app reader without channel.read_history on the requested channel before reading history', async () => {
    mocks.permission.mockImplementation(async (_c: unknown, permission: string) => permission === 'app.read')

    const response = await request({ app_id: 'com.example.app', channel_id: 42, days: 7 })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'channel_access_denied' })
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'channel.read_history', { appId: 'com.example.app', channelId: 42 })
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('still requires app.read before the channel check', async () => {
    mocks.permission.mockResolvedValue(false)

    const response = await request({ app_id: 'com.example.app', channel_id: 42, days: 7 })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'app_access_denied' })
    expect(mocks.permission).toHaveBeenCalledTimes(1)
    expect(mocks.from).not.toHaveBeenCalled()
  })
})
