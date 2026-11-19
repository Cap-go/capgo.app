import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/observe.ts'

const mocks = vi.hoisted(() => ({ permission: vi.fn(), stats: vi.fn(), insights: vi.fn(), release: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({ middlewareAuth: () => async (_c: unknown, next: () => Promise<void>) => next() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: (...args: unknown[]) => mocks.permission(...args) }))
vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({ readStats: (...args: unknown[]) => mocks.stats(...args), readStatsInsights: (...args: unknown[]) => mocks.insights(...args) }))
vi.mock('../supabase/functions/_backend/private/release_live.ts', () => ({ readReleaseLive: (...args: unknown[]) => mocks.release(...args) }))
vi.mock('../supabase/functions/_backend/private/native_observe_stats.ts', () => ({ nativeObserveActions: ['app_crash_native', 'app_launch_ready'], issueActions: ['app_crash_native'], readNativeObserveStats: vi.fn() }))

const post = (body: Record<string, unknown>) => app.request('http://local/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'com.example.monitoring', ...body }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.permission.mockResolvedValue(true)
  mocks.stats.mockResolvedValue([{ action: 'update_fail', device_id: 'example-device', version_name: '1.0.0', created_at: '2026-11-01T12:00:00Z', metadata: { reason: 'timeout' } }])
  mocks.insights.mockResolvedValue({ summary: { total: 1 }, actions: [{ action: 'update_fail', total: 1 }], daily: [], versions: [], devices: [] })
  mocks.release.mockResolvedValue({ release: null, channel: null, channels: [], recent_deployments: [] })
})

describe('Observe monitoring API', () => {
  it('returns updater failures with evidence, aggregate trends and fixes', async () => {
    const response = await post({ view: 'errors', source: 'updater' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ samples: [expect.objectContaining({ action: 'update_fail', metadata: { reason: 'timeout' }, diagnostic: expect.objectContaining({ classification: 'error' }) })], diagnostics: [expect.objectContaining({ next_steps: [expect.stringContaining('notifyAppReady')] })] })
    expect(mocks.stats.mock.calls[0][1].actions).toContain('update_fail')
    expect(mocks.stats.mock.calls[0][1].actions).not.toContain('app_crash_native')
    expect(mocks.stats.mock.calls[0][1].actions).not.toContain('channelPaused')
    expect(mocks.stats.mock.calls[0][1].actions).not.toContain('disableAutoUpdateToMajor')
  })
  it('keeps normal events in log and device queries', async () => {
    await post({ view: 'logs' })
    expect(mocks.stats.mock.calls[0][1]).toMatchObject({ order: [{ key: 'created_at', sortable: 'desc' }] })
    expect(mocks.stats.mock.calls[0][1].actions).toBeUndefined()
    await post({ view: 'device', deviceId: '00000000-0000-0000-0000-000000000001' })
    expect(mocks.stats.mock.calls[1][1].actions).toBeUndefined()
  })
  it.each(['errors', 'logs', 'device', 'metrics', 'routes'])('requires log permission before reading %s samples', async (view) => {
    mocks.permission.mockImplementation((_c, permission) => permission !== 'app.read_logs')
    const response = await post({ view, deviceId: view === 'device' ? '00000000-0000-0000-0000-000000000001' : undefined })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mocks.stats).not.toHaveBeenCalled()
    expect(mocks.insights).not.toHaveBeenCalled()
  })
  it('requires app permission before reading release data', async () => {
    mocks.permission.mockResolvedValue(false)
    expect((await post({ view: 'release' })).status).toBeGreaterThanOrEqual(400)
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it('reuses the dashboard reader and forwards channel and version selection', async () => {
    const response = await post({ view: 'release', channelId: 7, versionName: '1.2.0' })
    expect(response.status).toBe(200)
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), 'com.example.monitoring', 7, '1.2.0')
    expect(await response.json()).toMatchObject({ release: null, poll_after_seconds: 60 })
  })
  it.each([{ channelId: -1 }, { source: 'bad' }, { view: 'logs', channelId: 1 }, { view: 'release', source: 'native' }])('rejects invalid query %j', async (query) => {
    expect((await post(query)).status).toBeGreaterThanOrEqual(400)
    expect(mocks.stats).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })
})

it('allows explicitly inspecting policy events without counting them as default errors', async () => {
  mocks.stats.mockResolvedValueOnce([{ action: 'channelPaused', device_id: 'example-device', version_name: '1.0.0', created_at: '2026-11-01T12:00:00Z', metadata: {} }])
  mocks.insights.mockResolvedValueOnce({ summary: { total: 1 }, actions: [{ action: 'channelPaused', total: 1 }], daily: [], versions: [], devices: [] })
  const response = await post({ view: 'errors', action: 'channelPaused' })
  expect(response.status).toBe(200)
  expect(mocks.insights.mock.calls[0][1].actions).toEqual(['channelPaused'])
  expect(await response.json()).toMatchObject({ summary: { total: 1 }, actions: [{ action: 'channelPaused', total: 1 }], samples: [expect.objectContaining({ action: 'channelPaused', diagnostic: expect.objectContaining({ classification: 'policy' }) })] })
  expect(mocks.stats.mock.calls[0][1].actions).toEqual(['channelPaused'])
})
